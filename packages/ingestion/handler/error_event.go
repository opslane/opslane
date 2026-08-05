package handler

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"time"
	"unicode/utf8"

	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/grouping"
	"github.com/opslane/opslane/packages/ingestion/masking"
)

var rePlatformToken = regexp.MustCompile(`^[a-z0-9_-]{1,32}$`)
var reDebugID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var reCommitSHA = regexp.MustCompile(`^(?:[0-9a-f]{40}|[0-9a-f]{64})$`)

// truncateTitle caps a title at maxBytes without splitting a UTF-8 rune.
// Postgres rejects invalid byte sequences on TEXT input, so a mid-rune cut turns
// any long multi-byte message (localized apps) into a 500 on insert.
func truncateTitle(title string, maxBytes int) string {
	if len(title) <= maxBytes {
		return title
	}
	for maxBytes > 0 && !utf8.RuneStart(title[maxBytes]) {
		maxBytes--
	}
	return title[:maxBytes]
}

// groupingDecision runs the rung-0/rung-1 ladder in front of the legacy
// fingerprint. A non-empty suppressRule means the event is known noise and
// should not produce a fingerprint or event row.
func groupingDecision(platform, errorType, errorMessage, stackTrace string) (suppressRule, fingerprint, title string) {
	if rule, drop := grouping.Suppress(platform, errorMessage, stackTrace); drop {
		return rule, "", ""
	}

	title = truncateTitle(errorType+": "+errorMessage, 200)
	if familyFingerprint, ok := grouping.FamilyFingerprint(platform, errorMessage); ok {
		return "", familyFingerprint, grouping.FamilyTitleStaleDeploy
	}
	return "", grouping.Fingerprint(platform, errorType, errorMessage, stackTrace), title
}

// IngestEvent handles POST /api/v1/events (error events only).
func (d *Dependencies) IngestEvent(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		if err.Error() == "http: request body too large" {
			writeJSONError(w, http.StatusRequestEntityTooLarge, "request body too large")
			return
		}
		writeJSONError(w, http.StatusBadRequest, "failed to read body")
		return
	}
	d.ingestErrorEvent(w, r, body)
}

// IngestErrorEvent handles direct POST /api/v1/events calls (used by existing tests).
// Reads body from r.Body and delegates to ingestErrorEvent.
func (d *Dependencies) IngestErrorEvent(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		if err.Error() == "http: request body too large" {
			writeJSONError(w, http.StatusRequestEntityTooLarge, "request body too large")
			return
		}
		writeJSONError(w, http.StatusBadRequest, "failed to read body")
		return
	}
	d.ingestErrorEvent(w, r, body)
}

// ingestErrorEvent processes an error event from pre-read body bytes.
func (d *Dependencies) ingestErrorEvent(w http.ResponseWriter, r *http.Request, body []byte) {
	start := time.Now()

	projectID := ProjectIDFromCtx(r.Context())
	environmentID := EnvironmentIDFromCtx(r.Context())

	if projectID == "" || environmentID == "" {
		RecordIngestError("missing_tenant_context")
		writeJSONError(w, http.StatusUnauthorized, "missing tenant context")
		return
	}

	var payload struct {
		Timestamp string `json:"timestamp"`
		Error     struct {
			Type    string `json:"type"`
			Message string `json:"message"`
			Stack   string `json:"stack"`
		} `json:"error"`
		Breadcrumbs json.RawMessage `json:"breadcrumbs"`
		Context     json.RawMessage `json:"context"`
		Platform    string          `json:"platform"`
		Runtime     json.RawMessage `json:"runtime"`
		SDKVersion  string          `json:"sdk_version"`
		Release     string          `json:"release"`
		DebugMeta   json.RawMessage `json:"debug_meta"`
		CommitSHA   json.RawMessage `json:"commit_sha"`
		SessionID   string          `json:"session_id"`
		Environment string          `json:"environment"`
	}

	if err := json.Unmarshal(body, &payload); err != nil {
		RecordIngestError("invalid_json")
		writeJSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	// Validate: message is the only required error field. type and stack are
	// optional — many real browser errors have no stack (cross-origin
	// "Script error.", non-Error promise rejections) and must not be dropped.
	if payload.Error.Message == "" {
		RecordIngestError("missing_error_fields")
		writeJSONError(w, http.StatusBadRequest, "error.message is required")
		return
	}

	// Default an empty type BEFORE fingerprinting/title/insert so stackless
	// groups don't fragment on an empty type string.
	if payload.Error.Type == "" {
		payload.Error.Type = "Error"
	}
	if payload.Platform == "" || !rePlatformToken.MatchString(payload.Platform) {
		payload.Platform = "javascript"
	}
	debugMeta := sanitizeDebugMeta(payload.DebugMeta)
	commitSHA := sanitizeCommitSHA(payload.CommitSHA)

	// Default breadcrumbs/context
	breadcrumbs := "[]"
	if len(payload.Breadcrumbs) > 0 {
		breadcrumbs = string(payload.Breadcrumbs)
	}
	ctx := "{}"
	if len(payload.Context) > 0 {
		ctx = string(payload.Context)
	}

	// Runtime is a structured top-level wire field, but event context is the
	// existing JSONB persistence boundary. Normalize context to an object and
	// reserve context.runtime for a validated top-level runtime value. This
	// prevents callers from bypassing validation through context.runtime and
	// preserves valid runtime metadata when context is null or non-object JSON.
	var contextMap map[string]json.RawMessage
	if err := json.Unmarshal([]byte(ctx), &contextMap); err != nil || contextMap == nil {
		contextMap = map[string]json.RawMessage{}
	}
	delete(contextMap, "runtime")
	if len(payload.Runtime) > 0 {
		var runtime struct {
			Name    string `json:"name"`
			Version string `json:"version"`
		}
		if err := json.Unmarshal(payload.Runtime, &runtime); err == nil && runtime.Name != "" && runtime.Version != "" {
			if clean, err := json.Marshal(runtime); err == nil {
				contextMap["runtime"] = clean
			}
		}
	}
	if merged, err := json.Marshal(contextMap); err == nil {
		ctx = string(merged)
	}

	// Extract end-user identity from context.user (B2B tracking)
	type contextUser struct {
		ID          string `json:"id"`
		Email       string `json:"email"`
		AccountID   string `json:"account_id"`
		AccountName string `json:"account_name"`
	}
	var endUser contextUser
	if len(payload.Context) > 0 {
		var ctxObj struct {
			User *contextUser `json:"user"`
		}
		_ = json.Unmarshal(payload.Context, &ctxObj) // best-effort
		if ctxObj.User != nil && ctxObj.User.ID != "" {
			endUser = *ctxObj.User
		}
	}

	// Redact secrets before either suppression or persistence. End-user identity
	// was already extracted from raw context above, so B2B tracking remains
	// intact. RedactBreadcrumbs walks the whole array; retain the serialized
	// body/URL pass as defense in depth for malformed or future shapes.
	breadcrumbs = masking.RedactURL(masking.RedactBody(string(masking.RedactBreadcrumbs([]byte(breadcrumbs)))))
	ctx = string(masking.RedactContext([]byte(ctx)))

	suppressRule, fingerprint, title := groupingDecision(
		payload.Platform, payload.Error.Type, payload.Error.Message, payload.Error.Stack,
	)
	if suppressRule != "" {
		RecordSuppressed(suppressRule)
		RecordIngestDuration(time.Since(start).Seconds())
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"event_id":       "",
			"group_id":       "",
			"error_group_id": "",
			"suppressed":     true,
		})
		return
	}

	// Track stackless events so we can measure recovery volume in prod. This must
	// stay BELOW the suppression return: the script_error rule fires only on an
	// empty stack, so counting before it would fill an "accepted" counter with
	// events that were dropped.
	if payload.Error.Stack == "" {
		RecordStacklessAccepted()
	}

	if d.Queries == nil {
		RecordIngestError("no_db")
		writeJSONError(w, http.StatusInternalServerError, "database unavailable")
		return
	}

	result, err := d.Queries.InsertErrorEventAndGroup(r.Context(), db.IngestParams{
		ProjectID:            projectID,
		DefaultEnvironmentID: environmentID,
		EnvironmentLabel:     payload.Environment,
		EventTime:            resolveEventTime(payload.Timestamp, start),
		ErrorType:            payload.Error.Type,
		ErrorMessage:         payload.Error.Message,
		StackTraceRaw:        payload.Error.Stack,
		Fingerprint:          fingerprint,
		Title:                title,
		Breadcrumbs:          breadcrumbs,
		Context:              ctx,
		Release:              payload.Release,
		DebugMeta:            debugMeta.JSON,
		CommitSHA:            commitSHA,
		SessionID:            payload.SessionID,
		Platform:             payload.Platform,
		EndUserID:            endUser.ID,
		EndUserEmail:         endUser.Email,
		EndUserAccountID:     endUser.AccountID,
		EndUserAccountName:   endUser.AccountName,
	})
	if err != nil {
		RecordIngestError("db_error")
		writeJSONError(w, http.StatusInternalServerError, "failed to process event")
		return
	}
	RecordEnvironmentResolution(result.EnvironmentOutcome)
	if result.EnvironmentDiverged {
		RecordEnvironmentSessionDivergence()
	}

	RecordEventIngested(payload.Platform)
	if debugMeta.ImageCount > 0 {
		RecordEventWithDebugImages()
	}
	if debugMeta.RegistryPresentZeroMatched {
		RecordDebugMetaRegistryZeroMatched()
	}
	if result.IsNew || result.Requeued {
		RecordJobEnqueued()
	}
	RecordIngestDuration(time.Since(start).Seconds())

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(map[string]string{
		"event_id":       result.EventID,
		"group_id":       result.GroupID,
		"error_group_id": result.GroupID,
	})
}

type validatedDebugImage struct {
	Type     string `json:"type"`
	CodeFile string `json:"code_file"`
	DebugID  string `json:"debug_id"`
}

type debugMetaValidation struct {
	JSON                       string
	ImageCount                 int
	RegistryPresentZeroMatched bool
}

func sanitizeCommitSHA(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil || !reCommitSHA.MatchString(value) {
		RecordCommitSHADiscarded()
		return ""
	}
	return value
}

func sanitizeDebugMeta(raw json.RawMessage) debugMetaValidation {
	result := debugMetaValidation{JSON: `{"images":[]}`}
	if len(raw) == 0 {
		return result
	}

	var container map[string]json.RawMessage
	if trimmed := bytes.TrimSpace(raw); len(trimmed) == 0 || trimmed[0] != '{' ||
		json.Unmarshal(trimmed, &container) != nil || container == nil {
		RecordDebugMetaDiscard("malformed_container")
		return result
	}
	rawImages, present := container["images"]
	if !present {
		return result
	}
	trimmedImages := bytes.TrimSpace(rawImages)
	if len(trimmedImages) == 0 || trimmedImages[0] != '[' {
		RecordDebugMetaDiscard("malformed_images")
		return result
	}

	var entries []json.RawMessage
	if err := json.Unmarshal(trimmedImages, &entries); err != nil || entries == nil {
		RecordDebugMetaDiscard("malformed_images")
		return result
	}
	if len(entries) == 0 {
		result.RegistryPresentZeroMatched = true
		return result
	}

	valid := make([]validatedDebugImage, 0, len(entries))
	seen := make(map[string]struct{})
	for _, entry := range entries {
		var object map[string]json.RawMessage
		trimmedEntry := bytes.TrimSpace(entry)
		if len(trimmedEntry) == 0 || trimmedEntry[0] != '{' ||
			json.Unmarshal(trimmedEntry, &object) != nil || object == nil {
			RecordDebugMetaDiscard("non_object_image")
			continue
		}

		var image validatedDebugImage
		if err := json.Unmarshal(object["type"], &image.Type); err != nil || image.Type != "sourcemap" {
			RecordDebugMetaDiscard("bad_type")
			continue
		}
		if err := json.Unmarshal(object["code_file"], &image.CodeFile); err != nil || !validCodeFile(image.CodeFile) {
			RecordDebugMetaDiscard("bad_code_file")
			continue
		}
		if err := json.Unmarshal(object["debug_id"], &image.DebugID); err != nil || !reDebugID.MatchString(image.DebugID) {
			RecordDebugMetaDiscard("bad_debug_id")
			continue
		}

		pair := image.CodeFile + "\x00" + image.DebugID
		if _, duplicate := seen[pair]; duplicate {
			continue
		}
		seen[pair] = struct{}{}
		valid = append(valid, image)
	}

	idsByFile := make(map[string]map[string]struct{})
	for _, image := range valid {
		ids := idsByFile[image.CodeFile]
		if ids == nil {
			ids = make(map[string]struct{})
			idsByFile[image.CodeFile] = ids
		}
		ids[image.DebugID] = struct{}{}
	}

	retained := make([]validatedDebugImage, 0, min(len(valid), 64))
	for _, image := range valid {
		if len(idsByFile[image.CodeFile]) > 1 {
			RecordDebugMetaDiscard("ambiguous_code_file")
			continue
		}
		if len(retained) == 64 {
			RecordDebugMetaDiscard("over_limit")
			continue
		}
		retained = append(retained, image)
	}

	normalized, err := json.Marshal(struct {
		Images []validatedDebugImage `json:"images"`
	}{Images: retained})
	if err == nil {
		result.JSON = string(normalized)
	}
	result.ImageCount = len(retained)
	return result
}

func validCodeFile(value string) bool {
	if len(value) < 1 || len(value) > 4096 {
		return false
	}
	for _, character := range []byte(value) {
		if character < 0x20 || character == 0x7f {
			return false
		}
	}
	return true
}
