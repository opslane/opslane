package notify

import (
	"strings"
	"testing"
)

func TestBuildDigestViewV4SplitsCardsAndReceipts(t *testing.T) {
	digest := &DigestPayload{
		SchemaVersion: 4,
		Date:          "2026-08-27",
		GeneratedCards: []GeneratedDigestCard{
			{IncidentID: "i-new", Label: "new", Outcome: "needs_human", Title: "New issue"},
		},
		ReceiptItems: []ReceiptItem{
			{IncidentID: "i-wait", Kind: "error", Title: "Old issue", ReceiptState: "awaiting_approval"},
		},
		ReceiptOverflow: 2,
		DeliveryAlert:   "actionable lane degraded",
	}
	view := BuildDigestView(digest)
	if view.Legacy {
		t.Fatal("v4 must not be legacy")
	}
	if len(view.Cards) != 1 || view.Cards[0].IncidentID != "i-new" {
		t.Fatalf("cards = %+v", view.Cards)
	}
	if len(view.Receipts) != 1 || view.Receipts[0].IncidentID != "i-wait" {
		t.Fatalf("receipts = %+v", view.Receipts)
	}
	if view.ReceiptOverflow != 2 || view.DeliveryAlert != "actionable lane degraded" {
		t.Fatalf("counts/alert lost: %+v", view)
	}
	if view.Empty() {
		t.Fatal("view with items must not be Empty")
	}

	if !BuildDigestView(&DigestPayload{SchemaVersion: 4, Date: "2026-08-27"}).Empty() {
		t.Fatal("no cards, no receipts, no alert => Empty")
	}
	v2 := BuildDigestView(&DigestPayload{SchemaVersion: 2, Date: "2026-08-20", DeliveryAlert: "v2 alert",
		ReceiptItems: []ReceiptItem{{IncidentID: "i-v2", Kind: "error", ReceiptState: "awaiting_approval"}}})
	if len(v2.Receipts) != 1 || v2.Receipts[0].IncidentID != "i-v2" || v2.Legacy || v2.DeliveryAlert != "v2 alert" {
		t.Fatalf("v2 must map receipts and delivery alert, not flag legacy: %+v", v2)
	}
	v3 := BuildDigestView(&DigestPayload{SchemaVersion: 3, Date: "2026-08-22",
		GeneratedCards: []GeneratedDigestCard{{IncidentID: "i-v3", Label: "new"}}})
	if len(v3.Cards) != 1 || v3.Cards[0].IncidentID != "i-v3" || v3.Legacy {
		t.Fatalf("v3 must map cards, not flag legacy: %+v", v3)
	}
	v1 := BuildDigestView(&DigestPayload{Date: "2026-08-01"})
	if !v1.Legacy {
		t.Fatal("v1 (no schema_version) must report Legacy")
	}
	if BuildDigestView(nil).Date != "" {
		t.Fatal("nil digest must return zero view")
	}
}

// A receipt Slack would drop must not reach the other channels: the view
// applies the same admission rule, or it reintroduces the divergence it
// exists to remove.
func TestBuildDigestViewDropsReceiptsSlackCannotRender(t *testing.T) {
	digest := &DigestPayload{
		SchemaVersion: 4,
		Date:          "2026-08-27",
		ReceiptItems: []ReceiptItem{
			{IncidentID: "i-ok", Kind: "error", ReceiptState: "awaiting_approval", HasValidatedDiagnosis: true},
			{IncidentID: "i-bad-kind", Kind: "cluster", ReceiptState: "awaiting_approval", HasValidatedDiagnosis: true},
			{IncidentID: "i-bad-state", Kind: "error", ReceiptState: "not_a_state"},
		},
	}
	view := BuildDigestView(digest)
	if len(view.Receipts) != 1 || view.Receipts[0].IncidentID != "i-ok" {
		t.Fatalf("view must keep only the renderable receipt, got %+v", view.Receipts)
	}
	slackBody, _, err := formatSlackDigest(EventPayload{
		Version: 1, EventType: "digest.daily", Digest: digest,
		Project: ProjectRef{ID: "p", Name: "P"}, DashboardURL: "https://app.example.com",
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, dropped := range []string{"i-bad-kind", "i-bad-state"} {
		if strings.Contains(string(slackBody), dropped) {
			t.Fatalf("slack unexpectedly rendered %s", dropped)
		}
	}
}

// A digest whose entire content overflowed the render cap still has work
// waiting on the dashboard and must not report itself as quiet.
func TestDigestViewOverflowOnlyIsNotEmpty(t *testing.T) {
	view := BuildDigestView(&DigestPayload{SchemaVersion: 4, Date: "2026-08-27", ReceiptOverflow: 3})
	if view.Empty() {
		t.Fatal("a digest with deferred receipts is not empty")
	}
	if BuildDigestView(&DigestPayload{SchemaVersion: 4, Date: "2026-08-27", OverflowCount: 2}).Empty() {
		t.Fatal("a digest with deferred cards is not empty")
	}
}
