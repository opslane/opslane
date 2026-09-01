package billing

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/usageevents"
)

const (
	billingBatchSize           = 100
	defaultSweepInterval       = 5 * time.Minute
	defaultSessionAlertCeiling = 5000
)

// Sweeper reports durable merged-PR receipts and operator-only session alerts.
type Sweeper struct {
	Q                     *db.Queries
	Client                *Client
	SessionAlertThreshold int
}

// Start runs one immediate pass and then repeats until the context is canceled.
func (s *Sweeper) Start(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = defaultSweepInterval
	}
	s.runPass(ctx)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.runPass(ctx)
		}
	}
}

func (s *Sweeper) runPass(ctx context.Context) {
	billed, err := s.RunOnce(ctx)
	if err != nil {
		slog.Error("billing sweep failed", "error", err)
		return
	}
	if billed > 0 {
		slog.Info("billing sweep", "merged_prs_billed", billed)
	}
}

// RunOnce reports each receipt with a stable idempotency key, then records it
// locally only after Autumn accepts it. A provider failure leaves the receipt
// available for a later pass.
func (s *Sweeper) RunOnce(ctx context.Context) (int, error) {
	if s.Q == nil || s.Client == nil {
		return 0, errors.New("billing sweeper not configured")
	}
	prs, err := s.Q.ListUnbilledMergedPRs(ctx, billingBatchSize)
	if err != nil {
		return 0, err
	}

	billed := 0
	var firstErr error
	for _, pr := range prs {
		if pr.Ambiguous {
			// ProcessPRWebhook cannot safely choose an org when the same repo is
			// bound across orgs. Alert once and leave the receipt for reconciliation.
			inserted, markErr := s.Q.MarkBillingTracked(
				ctx, "ambiguous:"+pr.Ref, pr.OrgID, "ambiguous_org", 0,
			)
			if markErr != nil {
				if firstErr == nil {
					firstErr = markErr
				}
				continue
			}
			if inserted {
				usageevents.Emit("billing_ambiguous_org", map[string]string{
					"org_id": pr.OrgID,
					"ref":    pr.Ref,
				})
			}
			continue
		}

		if _, err := s.Client.EnsureCustomer(ctx, pr.OrgID, pr.OrgName); err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		if err := s.Client.Track(ctx, pr.OrgID, "merged_prs", pr.Ref, 1, pr.OccurredAt); err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		inserted, err := s.Q.MarkBillingTracked(ctx, pr.Ref, pr.OrgID, "merged_prs", 1)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		if !inserted {
			continue
		}
		usageevents.Emit("billable_pr_merged", map[string]string{
			"org_id": pr.OrgID,
			"pr":     strconv.Itoa(pr.PRNumber),
		})
		billed++
	}

	s.alertSessionCeilings(ctx)
	return billed, firstErr
}

// alertSessionCeilings is an operator signal, not a billing meter. It uses the
// free-plan ceiling for every org and dispatches at most once per UTC month.
func (s *Sweeper) alertSessionCeilings(ctx context.Context) {
	threshold := s.SessionAlertThreshold
	if threshold <= 0 {
		threshold = defaultSessionAlertCeiling
	}
	over, err := s.Q.OrgSessionCountsThisMonth(ctx, threshold)
	if err != nil {
		slog.Error("billing: session ceiling scan failed", "error", err)
		return
	}
	for orgID, count := range over {
		ref := fmt.Sprintf("sessions_alert:%s:%s", orgID, time.Now().UTC().Format("2006-01"))
		inserted, err := s.Q.MarkBillingTracked(ctx, ref, orgID, "sessions_alert", float64(count))
		if err != nil || !inserted {
			continue
		}
		usageevents.Emit("session_ceiling_exceeded", map[string]string{
			"org_id":   orgID,
			"sessions": strconv.Itoa(count),
		})
	}
}
