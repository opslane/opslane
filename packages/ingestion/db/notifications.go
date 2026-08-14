package db

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/opslane/opslane/packages/ingestion/notify"
)

type NotificationDestination struct {
	ID                 string
	ProjectID          string
	Type               string
	Name               string
	ConfigEncrypted    []byte
	ConfigFingerprint  string
	EventTypes         []string
	DeliveryPolicy     string
	Enabled            bool
	CreatedAt          time.Time
	UpdatedAt          time.Time
	LastDeliveryStatus *string
	LastDeliveryAt     *time.Time
	LastDeliveryError  *string
	RecentFailures     int
}

func scanNotificationDestination(row pgx.Row) (*NotificationDestination, error) {
	var destination NotificationDestination
	if err := row.Scan(
		&destination.ID,
		&destination.ProjectID,
		&destination.Type,
		&destination.Name,
		&destination.ConfigEncrypted,
		&destination.ConfigFingerprint,
		&destination.EventTypes,
		&destination.DeliveryPolicy,
		&destination.Enabled,
		&destination.CreatedAt,
		&destination.UpdatedAt,
	); err != nil {
		return nil, err
	}
	return &destination, nil
}

func (q *Queries) CreateNotificationDestination(
	ctx context.Context,
	orgID, projectID string,
	destination NotificationDestination,
) (*NotificationDestination, error) {
	if destination.DeliveryPolicy == "" {
		destination.DeliveryPolicy = "immediate"
	}
	created, err := scanNotificationDestination(q.pool.QueryRow(ctx, `
		INSERT INTO notification_destinations (
			id, project_id, type, name, config_encrypted, config_fingerprint, event_types, delivery_policy, enabled
		)
		SELECT $3, p.id, $4, $5, $6, $7, $8, $9, $10
		FROM projects p
		WHERE p.id = $2 AND p.org_id = $1
		RETURNING id, project_id, type, name, config_encrypted,
		          config_fingerprint, event_types, delivery_policy, enabled, created_at, updated_at`,
		orgID,
		projectID,
		destination.ID,
		destination.Type,
		destination.Name,
		destination.ConfigEncrypted,
		destination.ConfigFingerprint,
		destination.EventTypes,
		destination.DeliveryPolicy,
		destination.Enabled,
	))
	if err != nil {
		return nil, fmt.Errorf("create notification destination: %w", err)
	}
	return created, nil
}

func (q *Queries) ListNotificationDestinations(ctx context.Context, orgID, projectID string) ([]NotificationDestination, error) {
	rows, err := q.pool.Query(ctx, `
		SELECT d.id, d.project_id, d.type, d.name, d.config_encrypted, d.config_fingerprint,
		       d.event_types, d.delivery_policy, d.enabled, d.created_at, d.updated_at,
		       ld.status, ld.updated_at, ld.last_error, COALESCE(f.cnt, 0)
		FROM notification_destinations d
		JOIN projects p ON p.id = d.project_id AND p.org_id = $1
		LEFT JOIN LATERAL (
			SELECT status, updated_at, last_error
			FROM outbound_deliveries
			WHERE destination_id = d.id
			ORDER BY updated_at DESC
			LIMIT 1
		) ld ON true
		LEFT JOIN LATERAL (
			SELECT COUNT(*) AS cnt
			FROM outbound_deliveries
			WHERE destination_id = d.id
			  AND status = 'failed'
			  AND updated_at > now() - interval '7 days'
		) f ON true
		WHERE d.project_id = $2
		ORDER BY d.created_at`, orgID, projectID)
	if err != nil {
		return nil, fmt.Errorf("list notification destinations: %w", err)
	}
	defer rows.Close()

	destinations := make([]NotificationDestination, 0)
	for rows.Next() {
		var destination NotificationDestination
		if err := rows.Scan(
			&destination.ID,
			&destination.ProjectID,
			&destination.Type,
			&destination.Name,
			&destination.ConfigEncrypted,
			&destination.ConfigFingerprint,
			&destination.EventTypes,
			&destination.DeliveryPolicy,
			&destination.Enabled,
			&destination.CreatedAt,
			&destination.UpdatedAt,
			&destination.LastDeliveryStatus,
			&destination.LastDeliveryAt,
			&destination.LastDeliveryError,
			&destination.RecentFailures,
		); err != nil {
			return nil, fmt.Errorf("scan notification destination: %w", err)
		}
		destinations = append(destinations, destination)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list notification destinations: %w", err)
	}
	return destinations, nil
}

func (q *Queries) GetNotificationDestination(ctx context.Context, orgID, projectID, destinationID string) (*NotificationDestination, error) {
	destination, err := scanNotificationDestination(q.pool.QueryRow(ctx, `
		SELECT d.id, d.project_id, d.type, d.name, d.config_encrypted,
		       d.config_fingerprint, d.event_types, d.delivery_policy, d.enabled, d.created_at, d.updated_at
		FROM notification_destinations d
		JOIN projects p ON p.id = d.project_id AND p.org_id = $1
		WHERE d.project_id = $2 AND d.id = $3`, orgID, projectID, destinationID))
	if err != nil {
		return nil, fmt.Errorf("get notification destination: %w", err)
	}
	return destination, nil
}

func (q *Queries) UpdateNotificationDestination(
	ctx context.Context,
	orgID, projectID, destinationID string,
	name *string,
	configEncrypted []byte,
	configFingerprint *string,
	enabled *bool,
	eventTypes []string,
	deliveryPolicy *string,
) error {
	command, err := q.pool.Exec(ctx, `
		UPDATE notification_destinations d
		SET name = COALESCE($4, d.name),
		    config_encrypted = COALESCE($5::bytea, d.config_encrypted),
		    config_fingerprint = COALESCE($6, d.config_fingerprint),
		    enabled = COALESCE($7, d.enabled),
		    event_types = COALESCE($8, d.event_types),
		    delivery_policy = COALESCE($9, d.delivery_policy),
		    updated_at = now()
		FROM projects p
		WHERE d.id = $3 AND d.project_id = $2
		  AND p.id = d.project_id AND p.org_id = $1`,
		orgID,
		projectID,
		destinationID,
		name,
		configEncrypted,
		configFingerprint,
		enabled,
		eventTypes,
		deliveryPolicy,
	)
	if err != nil {
		return fmt.Errorf("update notification destination: %w", err)
	}
	if command.RowsAffected() == 0 {
		return fmt.Errorf("update notification destination: %w", pgx.ErrNoRows)
	}
	return nil
}

func (q *Queries) DeleteNotificationDestination(ctx context.Context, orgID, projectID, destinationID string) error {
	command, err := q.pool.Exec(ctx, `
		DELETE FROM notification_destinations d
		USING projects p
		WHERE d.id = $3 AND d.project_id = $2
		  AND p.id = d.project_id AND p.org_id = $1`,
		orgID, projectID, destinationID)
	if err != nil {
		return fmt.Errorf("delete notification destination: %w", err)
	}
	if command.RowsAffected() == 0 {
		return fmt.Errorf("delete notification destination: %w", pgx.ErrNoRows)
	}
	return nil
}

// publishIssueCreated writes transactional outbox rows for a brand-new error
// group. Any failure rolls back the enclosing ingest transaction.
func publishIssueCreated(
	ctx context.Context,
	tx pgx.Tx,
	dashboardURL, projectID, environmentID, groupID, title string,
	firstSeen time.Time,
) error {
	var hasDestination bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM notification_destinations
			WHERE project_id = $1 AND enabled AND 'issue.created' = ANY(event_types)
			  AND delivery_policy = 'immediate'
		)`, projectID).Scan(&hasDestination); err != nil {
		return fmt.Errorf("check destinations: %w", err)
	}
	if !hasDestination {
		return nil
	}

	var projectName, environmentName string
	if err := tx.QueryRow(ctx, `
		SELECT p.name, e.name
		FROM projects p, environments e
		WHERE p.id = $1 AND e.id = $2`, projectID, environmentID).Scan(&projectName, &environmentName); err != nil {
		return fmt.Errorf("lookup names: %w", err)
	}

	payload := notify.EventPayload{
		Version:      1,
		EventType:    "issue.created",
		Issue:        &notify.IssueRef{ID: groupID, Title: title, FirstSeen: firstSeen.UTC().Format(time.RFC3339)},
		Project:      notify.ProjectRef{ID: projectID, Name: projectName},
		Environment:  environmentName,
		DashboardURL: notify.BuildIncidentURL(dashboardURL, groupID, projectID),
	}
	if err := payload.Validate(); err != nil {
		return fmt.Errorf("validate payload: %w", err)
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal payload: %w", err)
	}

	if _, err := tx.Exec(ctx, `
		WITH destinations AS (
			SELECT id FROM notification_destinations
			WHERE project_id = $1 AND enabled AND $2 = ANY(event_types)
			  AND delivery_policy = 'immediate'
		), event AS (
			INSERT INTO outbound_events (project_id, event_type, dedup_key, payload)
			SELECT $1, $2, $3, $4::jsonb
			WHERE EXISTS (SELECT 1 FROM destinations)
			ON CONFLICT (project_id, dedup_key) DO NOTHING
			RETURNING id
		)
		INSERT INTO outbound_deliveries (event_id, destination_id)
		SELECT event.id, destinations.id FROM event CROSS JOIN destinations`,
		projectID,
		"issue.created",
		"issue.created:"+groupID,
		string(body),
	); err != nil {
		return fmt.Errorf("insert outbox rows: %w", err)
	}
	return nil
}
