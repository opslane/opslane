// Package billing integrates Opslane with Autumn. Billing is disabled when
// AUTUMN_SECRET_KEY is empty, and production-path access checks fail open when
// Autumn is unavailable.
package billing

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"
)

// Keep these paths in sync with packages/worker/src/billing.ts.
const (
	defaultBaseURL           = "https://api.useautumn.com"
	apiVersion               = "2.3.0"
	customersGetOrCreatePath = "/v1/customers.get_or_create"
	balancesCheckPath        = "/v1/balances.check"
	balancesTrackPath        = "/v1/balances.track"
	billingAttachPath        = "/v1/billing.attach"
	billingPortalPath        = "/v1/billing.open_customer_portal"
	duplicateIdempotencyCode = "duplicate_idempotency_key"
	defaultProPlanID         = "pro"
	defaultFreePlanID        = "free"
)

// Client is an Autumn REST client.
type Client struct {
	baseURL    string
	secretKey  string
	proPlanID  string
	freePlanID string
	httpc      *http.Client
}

// Balance describes Autumn's current balance for a feature.
type Balance struct {
	FeatureID      string  `json:"feature_id"`
	Granted        float64 `json:"granted"`
	Remaining      float64 `json:"remaining"`
	Usage          float64 `json:"usage"`
	Unlimited      bool    `json:"unlimited"`
	OverageAllowed bool    `json:"overage_allowed"`
	NextResetAt    int64   `json:"next_reset_at"`
}

// CheckResult is the outcome of an Autumn feature access check.
type CheckResult struct {
	Allowed    bool     `json:"allowed"`
	FailedOpen bool     `json:"-"`
	Balance    *Balance `json:"balance"`
}

// FromEnv returns nil when billing is disabled.
func FromEnv() *Client {
	key := strings.TrimSpace(os.Getenv("AUTUMN_SECRET_KEY"))
	if key == "" {
		return nil
	}
	baseURL := valueOrDefault(strings.TrimSpace(os.Getenv("AUTUMN_BASE_URL")), defaultBaseURL)
	proPlanID := valueOrDefault(strings.TrimSpace(os.Getenv("AUTUMN_PRO_PLAN_ID")), defaultProPlanID)
	freePlanID := valueOrDefault(strings.TrimSpace(os.Getenv("AUTUMN_FREE_PLAN_ID")), defaultFreePlanID)

	return &Client{
		baseURL:    baseURL,
		secretKey:  key,
		proPlanID:  proPlanID,
		freePlanID: freePlanID,
		httpc:      &http.Client{Timeout: 5 * time.Second},
	}
}

func valueOrDefault(value, fallback string) string {
	if value != "" {
		return value
	}
	return fallback
}

// Check checks feature access and allows access when Autumn is unavailable.
func (c *Client) Check(ctx context.Context, orgID, featureID string) CheckResult {
	result, err := c.CheckStrict(ctx, orgID, featureID)
	if err != nil {
		slog.Warn("billing check failed open", "feature", featureID, "error", err)
		return CheckResult{Allowed: true, FailedOpen: true}
	}
	return result
}

// CheckStrict checks feature access and surfaces provider failures.
func (c *Client) CheckStrict(ctx context.Context, orgID, featureID string) (CheckResult, error) {
	var response struct {
		Allowed *bool    `json:"allowed"`
		Balance *Balance `json:"balance"`
	}
	_, err := c.post(ctx, balancesCheckPath, map[string]any{
		"customer_id": orgID,
		"feature_id":  featureID,
	}, nil, &response)
	if err != nil {
		return CheckResult{}, err
	}
	if response.Allowed == nil {
		return CheckResult{}, errors.New("Autumn check response is missing an allowed verdict")
	}
	return CheckResult{Allowed: *response.Allowed, Balance: response.Balance}, nil
}

// EnsureCustomer returns the active plan after getting or creating an Autumn
// customer. New customers are auto-enabled on the configured free plan.
func (c *Client) EnsureCustomer(ctx context.Context, orgID, name string) (string, error) {
	var response struct {
		Subscriptions []struct {
			PlanID string `json:"plan_id"`
			Status string `json:"status"`
		} `json:"subscriptions"`
	}
	_, err := c.post(ctx, customersGetOrCreatePath, map[string]any{
		"customer_id":         orgID,
		"name":                name,
		"auto_enable_plan_id": c.freePlanID,
	}, nil, &response)
	if err != nil {
		return "", err
	}
	for _, subscription := range response.Subscriptions {
		if subscription.Status == "active" {
			return subscription.PlanID, nil
		}
	}
	return "", nil
}

// AttachPro starts checkout for the configured pro plan.
func (c *Client) AttachPro(ctx context.Context, orgID, successURL string) (string, error) {
	var response struct {
		PaymentURL string `json:"payment_url"`
	}
	_, err := c.post(ctx, billingAttachPath, map[string]any{
		"customer_id": orgID,
		"plan_id":     c.proPlanID,
		"success_url": successURL,
	}, nil, &response)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(response.PaymentURL) == "" {
		return "", errors.New("Autumn returned no payment URL; customer may already be subscribed or no payment is needed")
	}
	return response.PaymentURL, nil
}

// PortalURL opens the customer's Stripe billing portal.
func (c *Client) PortalURL(ctx context.Context, orgID, returnURL string) (string, error) {
	var response struct {
		URL string `json:"url"`
	}
	_, err := c.post(ctx, billingPortalPath, map[string]any{
		"customer_id": orgID,
		"return_url":  returnURL,
	}, nil, &response)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(response.URL) == "" {
		return "", errors.New("Autumn returned no billing portal URL")
	}
	return response.URL, nil
}

// Track records feature usage. The stable reference is sent in both supported
// idempotency locations; Autumn retains header keys for 24 hours, while the
// body key is also persisted with the usage event.
func (c *Client) Track(ctx context.Context, orgID, featureID, idempotencyRef string, value float64, occurredAt time.Time) error {
	_, err := c.post(ctx, balancesTrackPath, map[string]any{
		"customer_id":     orgID,
		"feature_id":      featureID,
		"idempotency_key": idempotencyRef,
		"value":           value,
		"timestamp":       occurredAt.UnixMilli(),
	}, map[string]string{"Idempotency-Key": idempotencyRef}, nil)
	if err == nil {
		return nil
	}

	var providerErr *providerError
	if !errors.As(err, &providerErr) || providerErr.status != http.StatusConflict {
		return err
	}
	var conflict struct {
		Code string `json:"code"`
	}
	if json.Unmarshal(providerErr.body, &conflict) == nil && conflict.Code == duplicateIdempotencyCode {
		return nil
	}
	return err
}

func (c *Client) post(ctx context.Context, path string, body any, headers map[string]string, out any) (int, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return 0, fmt.Errorf("encode Autumn request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(c.baseURL, "/")+path, bytes.NewReader(payload))
	if err != nil {
		return 0, fmt.Errorf("create Autumn request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.secretKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-version", apiVersion)
	for name, value := range headers {
		req.Header.Set(name, value)
	}

	resp, err := c.httpc.Do(req)
	if err != nil {
		return 0, fmt.Errorf("call Autumn: %w", err)
	}
	defer resp.Body.Close()

	responseBody, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return resp.StatusCode, fmt.Errorf("read Autumn response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return resp.StatusCode, &providerError{status: resp.StatusCode, body: responseBody}
	}
	if out == nil || len(bytes.TrimSpace(responseBody)) == 0 {
		return resp.StatusCode, nil
	}
	if err := json.Unmarshal(responseBody, out); err != nil {
		return resp.StatusCode, fmt.Errorf("decode Autumn response: %w", err)
	}
	return resp.StatusCode, nil
}

type providerError struct {
	status int
	body   []byte
}

func (e *providerError) Error() string {
	return fmt.Sprintf("Autumn returned HTTP %d: %s", e.status, strings.TrimSpace(string(e.body)))
}
