package handler

import (
	"log/slog"
	"net/http"
	"os"
	"strings"

	"github.com/opslane/opslane/packages/ingestion/billing"
)

const (
	mergedPRsFeatureID    = "merged_prs"
	investigationsFeature = "investigations"
)

type billingFeatureSummary struct {
	FeatureID      string  `json:"feature_id"`
	Allowed        bool    `json:"allowed"`
	Granted        float64 `json:"granted"`
	Usage          float64 `json:"usage"`
	Remaining      float64 `json:"remaining"`
	Unlimited      bool    `json:"unlimited"`
	OverageAllowed bool    `json:"overage_allowed"`
	NextResetAt    int64   `json:"next_reset_at"`
}

// requireBillingEnabled deliberately precedes authentication. When Autumn is
// disabled the billing HTTP surface does not exist, including to unauthenticated
// callers.
func (d *Dependencies) requireBillingEnabled(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if d.Billing == nil {
			writeJSONError(w, http.StatusNotFound, "not found")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// GetBillingSummary returns strict provider balances for the active org. This
// endpoint does not fail open: showing empty or stale balances in settings is
// less honest than reporting that the provider is unavailable.
func (d *Dependencies) GetBillingSummary(w http.ResponseWriter, r *http.Request) {
	orgID := OrgIDFromCtx(r.Context())
	planID, err := d.Billing.EnsureCustomer(r.Context(), orgID, d.billingCustomerName(r, orgID))
	if err != nil {
		slog.Warn("billing summary customer lookup failed", "org_id", orgID, "error", err)
		writeJSONError(w, http.StatusBadGateway, "billing provider unavailable")
		return
	}

	features := make([]billingFeatureSummary, 0, 2)
	for _, featureID := range []string{mergedPRsFeatureID, investigationsFeature} {
		result, err := d.Billing.CheckStrict(r.Context(), orgID, featureID)
		if err != nil || result.Balance == nil {
			slog.Warn("billing summary balance lookup failed", "org_id", orgID, "feature", featureID, "error", err)
			writeJSONError(w, http.StatusBadGateway, "billing provider unavailable")
			return
		}
		features = append(features, summarizeBillingFeature(featureID, result))
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"plan_id":  planID,
		"is_pro":   d.Billing.IsProPlan(planID),
		"features": features,
	})
}

func (d *Dependencies) CreateBillingCheckout(w http.ResponseWriter, r *http.Request) {
	url, err := d.Billing.AttachPro(r.Context(), OrgIDFromCtx(r.Context()), billingSettingsURL())
	if err != nil {
		slog.Warn("billing checkout failed", "org_id", OrgIDFromCtx(r.Context()), "error", err)
		if strings.Contains(err.Error(), "no payment URL") {
			writeJSONError(w, http.StatusBadGateway, "billing checkout unavailable: organization may be already subscribed or no payment is needed")
			return
		}
		writeJSONError(w, http.StatusBadGateway, "billing provider unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"url": url})
}

func (d *Dependencies) CreateBillingPortal(w http.ResponseWriter, r *http.Request) {
	url, err := d.Billing.PortalURL(r.Context(), OrgIDFromCtx(r.Context()), billingSettingsURL())
	if err != nil {
		slog.Warn("billing portal failed", "org_id", OrgIDFromCtx(r.Context()), "error", err)
		writeJSONError(w, http.StatusBadGateway, "billing provider unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"url": url})
}

func (d *Dependencies) billingCustomerName(r *http.Request, orgID string) string {
	if d.Queries == nil {
		return orgID
	}
	memberships, err := d.Queries.ListMembershipsByUser(r.Context(), UserIDFromCtx(r.Context()))
	if err != nil {
		return orgID
	}
	for _, membership := range memberships {
		if membership.OrgID == orgID && strings.TrimSpace(membership.OrgName) != "" {
			return membership.OrgName
		}
	}
	return orgID
}

func summarizeBillingFeature(featureID string, result billing.CheckResult) billingFeatureSummary {
	summary := billingFeatureSummary{FeatureID: featureID, Allowed: result.Allowed}
	if result.Balance == nil {
		return summary
	}
	summary.Granted = result.Balance.Granted
	summary.Usage = result.Balance.Usage
	summary.Remaining = result.Balance.Remaining
	summary.Unlimited = result.Balance.Unlimited
	summary.OverageAllowed = result.Balance.OverageAllowed
	summary.NextResetAt = result.Balance.NextResetAt
	return summary
}

// billingSettingsURL is empty when DASHBOARD_URL is unset: hosted billing
// pages reject relative success/return URLs, and the client omits the field
// entirely rather than sending one that fails every checkout.
func billingSettingsURL() string {
	base := strings.TrimRight(strings.TrimSpace(os.Getenv("DASHBOARD_URL")), "/")
	if base == "" {
		return ""
	}
	return base + "/settings?tab=billing"
}
