package handler

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/notify"
)

const notificationRequestLimit = 16 << 10

var knownNotificationEventTypes = map[string]struct{}{
	"issue.created": {},
	"digest.daily":  {},
}

type DigestBuilder interface {
	Build(ctx context.Context, projectID string, now time.Time) (notify.EventPayload, error)
}

type notificationDestinationJSON struct {
	ID                string                    `json:"id"`
	Type              string                    `json:"type"`
	Name              string                    `json:"name"`
	ConfigFingerprint string                    `json:"config_fingerprint"`
	EventTypes        []string                  `json:"event_types"`
	Enabled           bool                      `json:"enabled"`
	CreatedAt         time.Time                 `json:"created_at"`
	LastDelivery      *notificationDeliveryJSON `json:"last_delivery"`
	RecentFailures    int                       `json:"recent_failures"`
}

type notificationDeliveryJSON struct {
	Status string    `json:"status"`
	At     time.Time `json:"at"`
	Error  *string   `json:"error"`
}

type notificationListJSON struct {
	CanManage    bool                          `json:"can_manage"`
	Destinations []notificationDestinationJSON `json:"destinations"`
}

type createNotificationDestinationRequest struct {
	Name       string   `json:"name"`
	WebhookURL string   `json:"webhook_url"`
	EventTypes []string `json:"event_types"`
}

type updateNotificationDestinationRequest struct {
	Name       *string   `json:"name"`
	WebhookURL *string   `json:"webhook_url"`
	Enabled    *bool     `json:"enabled"`
	EventTypes *[]string `json:"event_types"`
}

type notificationConfig struct {
	WebhookURL string `json:"webhook_url"`
}

func notificationDestinationResponse(destination db.NotificationDestination) notificationDestinationJSON {
	response := notificationDestinationJSON{
		ID:                destination.ID,
		Type:              destination.Type,
		Name:              destination.Name,
		ConfigFingerprint: destination.ConfigFingerprint,
		EventTypes:        destination.EventTypes,
		Enabled:           destination.Enabled,
		CreatedAt:         destination.CreatedAt,
		RecentFailures:    destination.RecentFailures,
	}
	if destination.LastDeliveryStatus != nil && destination.LastDeliveryAt != nil {
		response.LastDelivery = &notificationDeliveryJSON{
			Status: *destination.LastDeliveryStatus,
			At:     *destination.LastDeliveryAt,
			Error:  destination.LastDeliveryError,
		}
	}
	return response
}

// requireIntegrationAdmin allows any authenticated org user in OSS mode and
// requires an admin membership in cloud mode.
func (d *Dependencies) requireIntegrationAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if d.cloudAuthEnabled() && !auth.RoleSatisfies(RoleFromCtx(r.Context()), "admin") {
			writeJSONError(w, http.StatusForbidden, "insufficient organization role")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (d *Dependencies) ListNotificationDestinationsEndpoint(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}
	destinations, err := d.Queries.ListNotificationDestinations(r.Context(), OrgIDFromCtx(r.Context()), projectID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to list notification destinations")
		return
	}
	response := notificationListJSON{
		CanManage:    !d.cloudAuthEnabled() || auth.RoleSatisfies(RoleFromCtx(r.Context()), "admin"),
		Destinations: make([]notificationDestinationJSON, 0, len(destinations)),
	}
	for _, destination := range destinations {
		response.Destinations = append(response.Destinations, notificationDestinationResponse(destination))
	}
	writeJSON(w, http.StatusOK, response)
}

func (d *Dependencies) CreateNotificationDestinationEndpoint(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}
	if d.ConfigCipher == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "notification configuration unavailable")
		return
	}
	var request createNotificationDestinationRequest
	if err := decodeNotificationRequest(r, &request); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	request.Name = strings.TrimSpace(request.Name)
	if err := validateNotificationName(request.Name); err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := notify.ValidateSlackWebhookURL(request.WebhookURL, d.NotifyExtraHosts); err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(request.EventTypes) == 0 {
		request.EventTypes = []string{"issue.created", "digest.daily"}
	}
	if !validNotificationEventTypes(request.EventTypes) {
		writeJSONError(w, http.StatusBadRequest, "event_types contains an unsupported value")
		return
	}

	destinationID := uuid.NewString()
	configJSON, err := json.Marshal(notificationConfig{WebhookURL: request.WebhookURL})
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to encode notification configuration")
		return
	}
	sealed, err := d.ConfigCipher.Seal(configJSON, notify.ConfigAAD(destinationID, projectID, "slack"))
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to encrypt notification configuration")
		return
	}
	created, err := d.Queries.CreateNotificationDestination(r.Context(), OrgIDFromCtx(r.Context()), projectID, db.NotificationDestination{
		ID:                destinationID,
		ProjectID:         projectID,
		Type:              "slack",
		Name:              request.Name,
		ConfigEncrypted:   sealed,
		ConfigFingerprint: notify.FingerprintURL(request.WebhookURL),
		EventTypes:        request.EventTypes,
		Enabled:           true,
	})
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to create notification destination")
		return
	}
	writeJSON(w, http.StatusCreated, notificationDestinationResponse(*created))
}

func (d *Dependencies) UpdateNotificationDestinationEndpoint(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}
	var request updateNotificationDestinationRequest
	if err := decodeNotificationRequest(r, &request); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if request.Name == nil && request.WebhookURL == nil && request.Enabled == nil && request.EventTypes == nil {
		writeJSONError(w, http.StatusBadRequest, "at least one field is required")
		return
	}
	if request.Name != nil {
		trimmed := strings.TrimSpace(*request.Name)
		request.Name = &trimmed
		if err := validateNotificationName(trimmed); err != nil {
			writeJSONError(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	var eventTypes []string
	if request.EventTypes != nil {
		if len(*request.EventTypes) == 0 || !validNotificationEventTypes(*request.EventTypes) {
			writeJSONError(w, http.StatusBadRequest, "event_types contains an unsupported value")
			return
		}
		eventTypes = *request.EventTypes
	}

	var sealed []byte
	var fingerprint *string
	if request.WebhookURL != nil {
		if d.ConfigCipher == nil {
			writeJSONError(w, http.StatusServiceUnavailable, "notification configuration unavailable")
			return
		}
		if err := notify.ValidateSlackWebhookURL(*request.WebhookURL, d.NotifyExtraHosts); err != nil {
			writeJSONError(w, http.StatusBadRequest, err.Error())
			return
		}
		configJSON, err := json.Marshal(notificationConfig{WebhookURL: *request.WebhookURL})
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "failed to encode notification configuration")
			return
		}
		sealed, err = d.ConfigCipher.Seal(configJSON, notify.ConfigAAD(chi.URLParam(r, "destID"), projectID, "slack"))
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "failed to encrypt notification configuration")
			return
		}
		masked := notify.FingerprintURL(*request.WebhookURL)
		fingerprint = &masked
	}
	if err := d.Queries.UpdateNotificationDestination(
		r.Context(),
		OrgIDFromCtx(r.Context()),
		projectID,
		chi.URLParam(r, "destID"),
		request.Name,
		sealed,
		fingerprint,
		request.Enabled,
		eventTypes,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeJSONError(w, http.StatusNotFound, "notification destination not found")
			return
		}
		writeJSONError(w, http.StatusInternalServerError, "failed to update notification destination")
		return
	}
	updated, err := d.Queries.GetNotificationDestination(r.Context(), OrgIDFromCtx(r.Context()), projectID, chi.URLParam(r, "destID"))
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to load updated notification destination")
		return
	}
	writeJSON(w, http.StatusOK, notificationDestinationResponse(*updated))
}

func (d *Dependencies) DeleteNotificationDestinationEndpoint(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}
	if err := d.Queries.DeleteNotificationDestination(r.Context(), OrgIDFromCtx(r.Context()), projectID, chi.URLParam(r, "destID")); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeJSONError(w, http.StatusNotFound, "notification destination not found")
			return
		}
		writeJSONError(w, http.StatusInternalServerError, "failed to delete notification destination")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (d *Dependencies) TestNotificationDestinationEndpoint(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}
	if d.ConfigCipher == nil || d.NotifySender == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "notification delivery unavailable")
		return
	}
	destination, err := d.Queries.GetNotificationDestination(r.Context(), OrgIDFromCtx(r.Context()), projectID, chi.URLParam(r, "destID"))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeJSONError(w, http.StatusNotFound, "notification destination not found")
			return
		}
		writeJSONError(w, http.StatusInternalServerError, "failed to load notification destination")
		return
	}
	plaintext, err := d.ConfigCipher.Open(destination.ConfigEncrypted, notify.ConfigAAD(destination.ID, projectID, destination.Type))
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to decrypt notification configuration")
		return
	}
	var config notificationConfig
	if err := json.Unmarshal(plaintext, &config); err != nil || config.WebhookURL == "" {
		writeJSONError(w, http.StatusInternalServerError, "invalid notification configuration")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, notificationRequestLimit)
	var request struct {
		EventType string `json:"event_type"`
	}
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		if !errors.Is(err, io.EOF) {
			writeJSONError(w, http.StatusBadRequest, "invalid request body")
			return
		}
	} else if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeJSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	var payload notify.EventPayload
	switch request.EventType {
	case "", "issue.created":
		payload = notify.EventPayload{
			Version:     1,
			EventType:   "issue.created",
			Issue:       &notify.IssueRef{ID: "test", Title: "Test notification from Opslane", FirstSeen: time.Now().UTC().Format(time.RFC3339)},
			Project:     notify.ProjectRef{ID: projectID, Name: "Opslane"},
			Environment: "test",
		}
	case "digest.daily":
		if d.DigestBuilder == nil {
			writeJSONError(w, http.StatusServiceUnavailable, "digest unavailable")
			return
		}
		var err error
		payload, err = d.DigestBuilder.Build(r.Context(), projectID, time.Now().UTC())
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "failed to build digest")
			return
		}
	default:
		writeJSONError(w, http.StatusBadRequest, "unsupported event_type")
		return
	}

	outcome := d.NotifySender.Send(r.Context(), destination.Type, config.WebhookURL, payload)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":             outcome.Class == "delivered",
		"classification": outcome.Class,
		"status_code":    outcome.StatusCode,
	})
}

func decodeNotificationRequest(r *http.Request, target any) error {
	decoder := json.NewDecoder(io.LimitReader(r.Body, notificationRequestLimit))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("multiple JSON values")
	}
	return nil
}

func validateNotificationName(name string) error {
	length := len([]rune(name))
	if length == 0 {
		return errors.New("name is required")
	}
	if length > 200 {
		return errors.New("name must be 200 characters or less")
	}
	return nil
}

func validNotificationEventTypes(eventTypes []string) bool {
	if len(eventTypes) == 0 {
		return false
	}
	for _, eventType := range eventTypes {
		if _, ok := knownNotificationEventTypes[eventType]; !ok {
			return false
		}
	}
	return true
}
