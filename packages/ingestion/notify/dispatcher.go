package notify

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opslane/opslane/packages/ingestion/masking"
	"github.com/opslane/opslane/packages/ingestion/usageevents"
)

const (
	defaultPollInterval  = 5 * time.Second
	defaultBatchSize     = 10
	defaultHTTPTimeout   = 10 * time.Second
	defaultLeaseDuration = 90 * time.Second
	pruneInterval        = time.Hour
	defaultPruneBatch    = 1000
	maxPruneBatches      = 5
	maxRetryAfter        = time.Hour
	maxResponseBody      = 4 << 10
	maxReasonLength      = 500
)

// Sender validates, formats, POSTs, and classifies one delivery attempt.
type Sender struct {
	Client     *http.Client
	ExtraHosts []string
}

// Outcome describes the result of one outbound delivery attempt.
type Outcome struct {
	Class      string
	StatusCode int
	RetryAfter time.Duration
	Reason     string
}

// NewSender returns a sender with the notification HTTP safety defaults.
func NewSender(timeout time.Duration, extraHosts []string) *Sender {
	if timeout <= 0 {
		timeout = defaultHTTPTimeout
	}
	return &Sender{
		Client: &http.Client{
			Timeout: timeout,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		ExtraHosts: append([]string(nil), extraHosts...),
	}
}

// Send re-validates the destination URL, formats the event, sends it, and
// classifies the response. Transport errors are deliberately converted to
// fixed strings because net/http errors can embed the credential-bearing URL.
func (s *Sender) Send(ctx context.Context, destType, webhookURL string, payload EventPayload) (outcome Outcome) {
	defer func() {
		if outcome.Class != "" {
			RecordDelivery(destType, outcome.Class)
		}
	}()

	if err := ValidateSlackWebhookURL(webhookURL, s.ExtraHosts); err != nil {
		return Outcome{Class: "permanent", Reason: "invalid_destination_url"}
	}
	formatter, ok := Formatters[destType]
	if !ok {
		return Outcome{Class: "permanent", Reason: "unsupported_destination_type"}
	}
	body, contentType, err := formatter.Format(payload)
	if err != nil {
		return Outcome{Class: "permanent", Reason: "format_error"}
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, webhookURL, bytes.NewReader(body))
	if err != nil {
		return Outcome{Class: "permanent", Reason: "invalid_destination_request"}
	}
	req.Header.Set("Content-Type", contentType)

	client := s.Client
	if client == nil {
		client = NewSender(defaultHTTPTimeout, s.ExtraHosts).Client
	}
	resp, err := client.Do(req)
	if err != nil {
		return Outcome{Class: "retry", Reason: classifyTransportError(ctx, err)}
	}
	defer resp.Body.Close()

	responseBody, readErr := io.ReadAll(io.LimitReader(resp.Body, maxResponseBody))
	reason := responseReason(resp.StatusCode, responseBody, webhookURL)
	if readErr != nil {
		reason = truncateReason(fmt.Sprintf("http %d: response body read error", resp.StatusCode))
	}
	outcome = Outcome{StatusCode: resp.StatusCode, Reason: reason}

	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		outcome.Class = "delivered"
	case resp.StatusCode == http.StatusTooManyRequests:
		outcome.Class = "retry"
		outcome.RetryAfter = parseRetryAfter(resp.Header.Get("Retry-After"), time.Now())
	case resp.StatusCode == http.StatusRequestTimeout:
		outcome.Class = "retry"
	case resp.StatusCode >= 500 && resp.StatusCode < 600:
		outcome.Class = "retry"
	case resp.StatusCode >= 300 && resp.StatusCode < 500:
		outcome.Class = "permanent"
	default:
		outcome.Class = "permanent"
	}
	return outcome
}

func classifyTransportError(ctx context.Context, err error) string {
	switch {
	case errors.Is(err, context.DeadlineExceeded), errors.Is(ctx.Err(), context.DeadlineExceeded), os.IsTimeout(err):
		return "request_timeout"
	case errors.Is(err, context.Canceled), errors.Is(ctx.Err(), context.Canceled):
		return "request_canceled"
	case errors.Is(err, syscall.ECONNREFUSED):
		return "connection_refused"
	case errors.Is(err, syscall.ECONNRESET):
		return "connection_reset"
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return "request_timeout"
	}
	return "network_error"
}

func responseReason(status int, body []byte, webhookURL string) string {
	text := strings.TrimSpace(string(body))
	text = masking.RedactURL(masking.RedactBody(text))
	text = redactWebhookReference(text, webhookURL)
	text = strings.Join(strings.Fields(text), " ")
	if text == "" {
		return truncateReason(fmt.Sprintf("http %d", status))
	}
	return truncateReason(fmt.Sprintf("http %d: %s", status, text))
}

func redactWebhookReference(value, webhookURL string) string {
	value = strings.ReplaceAll(value, webhookURL, "[REDACTED]")
	parsed, err := url.Parse(webhookURL)
	if err != nil {
		return value
	}
	for _, secret := range []string{parsed.RequestURI(), parsed.EscapedPath(), parsed.Path} {
		if secret != "" && secret != "/" {
			value = strings.ReplaceAll(value, secret, "[REDACTED]")
		}
	}
	return value
}

func truncateReason(value string) string {
	runes := []rune(value)
	if len(runes) <= maxReasonLength {
		return value
	}
	return string(runes[:maxReasonLength])
}

func parseRetryAfter(value string, now time.Time) time.Duration {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0
	}
	if seconds, err := strconv.ParseInt(value, 10, 64); err == nil {
		if seconds <= 0 {
			return 0
		}
		return minDuration(time.Duration(seconds)*time.Second, maxRetryAfter)
	}
	when, err := http.ParseTime(value)
	if err != nil {
		return 0
	}
	delay := when.Sub(now)
	if delay <= 0 {
		return 0
	}
	return minDuration(delay, maxRetryAfter)
}

func minDuration(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}

// Options controls dispatcher timing and concurrency. Zero values use safe
// production defaults.
type Options struct {
	PollInterval  time.Duration
	BatchSize     int
	HTTPTimeout   time.Duration
	LeaseDuration time.Duration
	ExtraHosts    []string
}

type Dispatcher struct {
	pool   *pgxpool.Pool
	cipher *ConfigCipher
	opts   Options
	sender *Sender
}

// New constructs a dispatcher and fills every zero-valued option.
func New(pool *pgxpool.Pool, cipher *ConfigCipher, opts Options) *Dispatcher {
	if opts.PollInterval <= 0 {
		opts.PollInterval = defaultPollInterval
	}
	if opts.BatchSize <= 0 {
		opts.BatchSize = defaultBatchSize
	}
	if opts.HTTPTimeout <= 0 {
		opts.HTTPTimeout = defaultHTTPTimeout
	}
	if opts.LeaseDuration <= 0 {
		opts.LeaseDuration = defaultLeaseDuration
	}
	opts.ExtraHosts = append([]string(nil), opts.ExtraHosts...)
	return &Dispatcher{
		pool:   pool,
		cipher: cipher,
		opts:   opts,
		sender: NewSender(opts.HTTPTimeout, opts.ExtraHosts),
	}
}

// Run reaps abandoned claims, claims due deliveries, and processes each batch
// concurrently. Pruning runs on an independent hourly cadence.
func (d *Dispatcher) Run(ctx context.Context) {
	pruneTicker := time.NewTicker(pruneInterval)
	defer pruneTicker.Stop()

	for {
		if _, err := d.reapExpired(ctx); err != nil && ctx.Err() == nil {
			slog.Error("notification lease reaper failed", "error", err)
		}
		claims, err := d.claim(ctx)
		if err != nil && ctx.Err() == nil {
			slog.Error("notification delivery claim failed", "error", err)
		} else {
			d.deliverBatch(ctx, claims)
		}

		timer := time.NewTimer(d.opts.PollInterval)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			return
		case <-pruneTicker.C:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			if _, _, err := d.prune(ctx, defaultPruneBatch); err != nil && ctx.Err() == nil {
				slog.Error("notification outbox pruning failed", "error", err)
			}
		case <-timer.C:
		}
	}
}

type deliveryClaim struct {
	ID              string
	EventID         string
	DestinationID   string
	Attempts        int
	MaxAttempts     int
	LeaseGeneration int64
}

func (d *Dispatcher) claim(ctx context.Context) ([]deliveryClaim, error) {
	rows, err := d.pool.Query(ctx, `
		UPDATE outbound_deliveries d SET
		  status = 'delivering',
		  attempts = d.attempts + 1,
		  lease_generation = d.lease_generation + 1,
		  lease_expires_at = now() + make_interval(secs => $2::double precision),
		  updated_at = now()
		WHERE d.id IN (
		  SELECT id FROM outbound_deliveries
		  WHERE status = 'pending'
		    AND next_attempt_at <= now()
		    AND attempts < max_attempts
		  ORDER BY next_attempt_at LIMIT $1
		  FOR UPDATE SKIP LOCKED
		)
		RETURNING d.id, d.event_id, d.destination_id, d.attempts, d.max_attempts,
		          d.lease_generation`, d.opts.BatchSize, d.opts.LeaseDuration.Seconds())
	if err != nil {
		return nil, fmt.Errorf("claim deliveries: %w", err)
	}
	defer rows.Close()

	claims := make([]deliveryClaim, 0, d.opts.BatchSize)
	for rows.Next() {
		var claim deliveryClaim
		if err := rows.Scan(&claim.ID, &claim.EventID, &claim.DestinationID, &claim.Attempts, &claim.MaxAttempts, &claim.LeaseGeneration); err != nil {
			return nil, fmt.Errorf("scan delivery claim: %w", err)
		}
		claims = append(claims, claim)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate delivery claims: %w", err)
	}
	return claims, nil
}

func (d *Dispatcher) deliverBatch(ctx context.Context, claims []deliveryClaim) {
	var wg sync.WaitGroup
	wg.Add(len(claims))
	for _, claim := range claims {
		claim := claim
		go func() {
			defer wg.Done()
			d.deliverClaim(ctx, claim)
		}()
	}
	wg.Wait()
}

type destinationConfig struct {
	WebhookURL string `json:"webhook_url"`
}

func (d *Dispatcher) deliverClaim(ctx context.Context, claim deliveryClaim) {
	destType := "unknown"
	projectID := ""
	defer func() {
		if recovered := recover(); recovered != nil {
			outcome := Outcome{Class: "retry", Reason: "delivery_panic"}
			d.finishClaim(ctx, claim, projectID, destType, nil, outcome, false)
		}
	}()

	var enabled bool
	var configEncrypted, payloadJSON []byte
	err := d.pool.QueryRow(ctx, `
		SELECT e.project_id, e.payload, nd.type, nd.enabled, nd.config_encrypted
		FROM outbound_events e
		JOIN notification_destinations nd ON nd.id = $2
		WHERE e.id = $1`, claim.EventID, claim.DestinationID,
	).Scan(&projectID, &payloadJSON, &destType, &enabled, &configEncrypted)
	if errors.Is(err, pgx.ErrNoRows) {
		d.finishClaim(ctx, claim, projectID, destType, nil, Outcome{Class: "permanent", Reason: "destination_or_event_missing"}, false)
		return
	}
	if err != nil {
		d.finishClaim(ctx, claim, projectID, destType, nil, Outcome{Class: "retry", Reason: "delivery_load_failed"}, false)
		return
	}
	if !enabled {
		d.finishClaim(ctx, claim, projectID, destType, nil, Outcome{Class: "permanent", Reason: "destination_disabled"}, false)
		return
	}
	if d.cipher == nil {
		d.finishClaim(ctx, claim, projectID, destType, nil, Outcome{Class: "permanent", Reason: "config_cipher_unavailable"}, false)
		return
	}

	plaintext, err := d.cipher.Open(configEncrypted, ConfigAAD(claim.DestinationID, projectID, destType))
	if err != nil {
		d.finishClaim(ctx, claim, projectID, destType, nil, Outcome{Class: "permanent", Reason: "config_decrypt_failed"}, false)
		return
	}
	var config destinationConfig
	if err := json.Unmarshal(plaintext, &config); err != nil || config.WebhookURL == "" {
		d.finishClaim(ctx, claim, projectID, destType, nil, Outcome{Class: "permanent", Reason: "config_invalid"}, false)
		return
	}
	var payload EventPayload
	if err := json.Unmarshal(payloadJSON, &payload); err != nil {
		d.finishClaim(ctx, claim, projectID, destType, nil, Outcome{Class: "permanent", Reason: "event_payload_invalid"}, false)
		return
	}

	d.finishClaim(ctx, claim, projectID, destType, &payload, d.sender.Send(ctx, destType, config.WebhookURL, payload), true)
}

func (d *Dispatcher) finishClaim(ctx context.Context, claim deliveryClaim, projectID, destType string, payload *EventPayload, outcome Outcome, metricRecorded bool) {
	// Sender records HTTP outcomes itself. Pre-send dispatcher outcomes still
	// need to appear in the same metric.
	if !metricRecorded {
		RecordDelivery(destType, outcome.Class)
	}
	updated, err := d.complete(ctx, claim, outcome)
	if err != nil {
		if ctx.Err() == nil {
			slog.Error("notification delivery completion failed", "delivery_id", claim.ID, "error", err)
		}
		return
	}
	if !updated {
		return
	}
	if outcome.Class == "delivered" && payload != nil && payload.EventType == "digest.daily" {
		props := map[string]string{
			"project_id":   projectID,
			"project_name": payload.Project.Name,
			"run_id":       payload.RunID,
		}
		if payload.Digest != nil {
			props["date"] = payload.Digest.Date
			props["new_issues"] = strconv.Itoa(len(payload.Digest.TopNewIssues))
			props["needs_human_backlog"] = strconv.Itoa(payload.Digest.NeedsHumanBacklog)
		}
		usageevents.Emit("digest_delivered", props)
	}
	terminal := outcome.Class == "permanent" || (outcome.Class == "retry" && claim.Attempts >= claim.MaxAttempts)
	if terminal {
		slog.Warn("notification delivery failed", "delivery_id", claim.ID, "destination_id", claim.DestinationID,
			"project_id", projectID, "type", destType, "reason", outcome.Reason)
	}
}

func (d *Dispatcher) complete(ctx context.Context, claim deliveryClaim, outcome Outcome) (bool, error) {
	var tag pgconn.CommandTag
	var err error
	switch outcome.Class {
	case "delivered":
		tag, err = d.pool.Exec(ctx, `
			UPDATE outbound_deliveries SET status = 'delivered', delivered_at = now(),
			  lease_expires_at = NULL, last_error = NULL, updated_at = now()
			WHERE id = $1 AND status = 'delivering' AND lease_generation = $2`,
			claim.ID, claim.LeaseGeneration)
	case "retry":
		if claim.Attempts >= claim.MaxAttempts {
			tag, err = d.pool.Exec(ctx, `
				UPDATE outbound_deliveries SET status = 'failed', lease_expires_at = NULL,
				  last_error = $3, updated_at = now()
				WHERE id = $1 AND status = 'delivering' AND lease_generation = $2`,
				claim.ID, claim.LeaseGeneration, truncateReason(outcome.Reason))
		} else {
			delay := outcome.RetryAfter
			if delay <= 0 {
				delay = backoff(claim.Attempts)
			}
			tag, err = d.pool.Exec(ctx, `
				UPDATE outbound_deliveries SET status = 'pending', lease_expires_at = NULL,
				  next_attempt_at = now() + make_interval(secs => $4::double precision),
				  last_error = $3, updated_at = now()
				WHERE id = $1 AND status = 'delivering' AND lease_generation = $2`,
				claim.ID, claim.LeaseGeneration, truncateReason(outcome.Reason), delay.Seconds())
		}
	case "permanent":
		tag, err = d.pool.Exec(ctx, `
			UPDATE outbound_deliveries SET status = 'failed', lease_expires_at = NULL,
			  last_error = $3, updated_at = now()
			WHERE id = $1 AND status = 'delivering' AND lease_generation = $2`,
			claim.ID, claim.LeaseGeneration, truncateReason(outcome.Reason))
	default:
		return false, fmt.Errorf("unknown delivery outcome %q", outcome.Class)
	}
	if err != nil {
		return false, fmt.Errorf("complete delivery: %w", err)
	}
	return tag.RowsAffected() > 0, nil
}

func backoff(attempt int) time.Duration {
	switch attempt {
	case 1:
		return 30 * time.Second
	case 2:
		return 2 * time.Minute
	case 3:
		return 10 * time.Minute
	case 4:
		return 30 * time.Minute
	default:
		return time.Hour
	}
}

func (d *Dispatcher) reapExpired(ctx context.Context) (int64, error) {
	rows, err := d.pool.Query(ctx, `
		WITH reaped AS (
		  UPDATE outbound_deliveries SET
		    status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
		    last_error = CASE WHEN attempts >= max_attempts THEN 'lease expired on final attempt' ELSE last_error END,
		    next_attempt_at = now() + (CASE attempts WHEN 1 THEN interval '30 seconds' WHEN 2 THEN interval '2 minutes' WHEN 3 THEN interval '10 minutes' WHEN 4 THEN interval '30 minutes' ELSE interval '1 hour' END),
		    lease_expires_at = NULL,
		    updated_at = now()
		  WHERE status = 'delivering' AND lease_expires_at < now()
		  RETURNING destination_id, status, last_error
		)
		SELECT r.status, COALESCE(r.last_error, ''), nd.id, nd.project_id, nd.type
		FROM reaped r
		JOIN notification_destinations nd ON nd.id = r.destination_id`)
	if err != nil {
		return 0, fmt.Errorf("reap expired delivery leases: %w", err)
	}
	defer rows.Close()
	var count int64
	for rows.Next() {
		var status, reason, destinationID, projectID, destType string
		if err := rows.Scan(&status, &reason, &destinationID, &projectID, &destType); err != nil {
			return count, fmt.Errorf("scan reaped delivery: %w", err)
		}
		count++
		RecordDelivery(destType, "retry")
		if status == "failed" {
			slog.Warn("notification delivery failed", "destination_id", destinationID,
				"project_id", projectID, "type", destType, "reason", reason)
		}
	}
	if err := rows.Err(); err != nil {
		return count, fmt.Errorf("iterate reaped deliveries: %w", err)
	}
	return count, nil
}

func (d *Dispatcher) prune(ctx context.Context, batchSize int) (deliveries, events int64, err error) {
	if batchSize <= 0 {
		batchSize = defaultPruneBatch
	}
	for range maxPruneBatches {
		tag, execErr := d.pool.Exec(ctx, `
			WITH del AS (
			  SELECT id FROM outbound_deliveries
			  WHERE status <> 'pending' AND status <> 'delivering'
			    AND updated_at < now() - interval '30 days'
			  LIMIT $1
			  FOR UPDATE SKIP LOCKED
			)
			DELETE FROM outbound_deliveries WHERE id IN (SELECT id FROM del)`, batchSize)
		if execErr != nil {
			return deliveries, events, fmt.Errorf("prune deliveries: %w", execErr)
		}
		count := tag.RowsAffected()
		deliveries += count
		if count < int64(batchSize) {
			break
		}
	}
	for range maxPruneBatches {
		tag, execErr := d.pool.Exec(ctx, `
			WITH del AS (
			  SELECT e.id FROM outbound_events e
			  WHERE e.created_at < now() - interval '30 days'
			    AND NOT EXISTS (SELECT 1 FROM outbound_deliveries d WHERE d.event_id = e.id)
			  LIMIT $1
			  FOR UPDATE SKIP LOCKED
			)
			DELETE FROM outbound_events WHERE id IN (SELECT id FROM del)`, batchSize)
		if execErr != nil {
			return deliveries, events, fmt.Errorf("prune events: %w", execErr)
		}
		count := tag.RowsAffected()
		events += count
		if count < int64(batchSize) {
			break
		}
	}
	return deliveries, events, nil
}

type deliveryMetricKey struct {
	DestinationType string
	Outcome         string
}

var deliveryMetrics struct {
	mu     sync.Mutex
	counts map[deliveryMetricKey]*atomic.Int64
}

// RecordDelivery increments the notification delivery-attempt metric.
func RecordDelivery(destType, outcome string) {
	deliveryMetrics.mu.Lock()
	if deliveryMetrics.counts == nil {
		deliveryMetrics.counts = make(map[deliveryMetricKey]*atomic.Int64)
	}
	key := deliveryMetricKey{DestinationType: destType, Outcome: outcome}
	counter := deliveryMetrics.counts[key]
	if counter == nil {
		counter = &atomic.Int64{}
		deliveryMetrics.counts[key] = counter
	}
	deliveryMetrics.mu.Unlock()
	counter.Add(1)
}

// DeliveryMetric is one stable snapshot row for Prometheus rendering.
type DeliveryMetric struct {
	DestinationType string
	Outcome         string
	Count           int64
}

// DeliveryMetricsSnapshot returns a deterministic copy of all counters.
func DeliveryMetricsSnapshot() []DeliveryMetric {
	deliveryMetrics.mu.Lock()
	metrics := make([]DeliveryMetric, 0, len(deliveryMetrics.counts))
	for key, counter := range deliveryMetrics.counts {
		metrics = append(metrics, DeliveryMetric{
			DestinationType: key.DestinationType,
			Outcome:         key.Outcome,
			Count:           counter.Load(),
		})
	}
	deliveryMetrics.mu.Unlock()
	sort.Slice(metrics, func(i, j int) bool {
		if metrics[i].DestinationType == metrics[j].DestinationType {
			return metrics[i].Outcome < metrics[j].Outcome
		}
		return metrics[i].DestinationType < metrics[j].DestinationType
	})
	return metrics
}
