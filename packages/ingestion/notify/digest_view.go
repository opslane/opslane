package notify

// DigestView is the one shared interpretation of a stored digest payload.
// Every non-Slack consumer (MCP, read API, digest-eval) builds its rendering
// from this view instead of plucking fields, so the channels cannot disagree
// about what a digest contains. Slack's per-version renderers are a delivery
// compatibility surface and stay independent.
type DigestView struct {
	Date            string
	Cards           []GeneratedDigestCard
	Receipts        []ReceiptItem
	ReceiptOverflow int
	OverflowCount   int
	DeliveryAlert   string
	SchemaVersion   int
	// Legacy is true only for v1 payloads (schema_version absent), which
	// carry neither cards nor receipts. v2 and v3 map their lane into the
	// view so stored pre-v4 digests keep rendering everywhere.
	Legacy bool
}

// Empty reports whether the digest contained nothing to act on: no new
// cards, no standing receipts, and no delivery alert.
func (v DigestView) Empty() bool {
	return len(v.Cards) == 0 && len(v.Receipts) == 0 && v.DeliveryAlert == ""
}

// BuildDigestView maps every stored digest version into the shared view.
func BuildDigestView(digest *DigestPayload) DigestView {
	if digest == nil {
		return DigestView{}
	}
	view := DigestView{Date: digest.Date, SchemaVersion: digest.SchemaVersion}
	// Version mapping mirrors the Slack renderer switch (slack_digest.go):
	// v4 carries cards + receipts; v3 carried cards; v2 carried receipts;
	// v1 (schema_version 0/1) has neither and is reported as Legacy.
	switch {
	case digest.SchemaVersion >= 4:
		view.Cards = digest.GeneratedCards
		view.Receipts = digest.ReceiptItems
		view.ReceiptOverflow = digest.ReceiptOverflow
		view.OverflowCount = digest.OverflowCount
		view.DeliveryAlert = digest.DeliveryAlert
	case digest.SchemaVersion == 3:
		view.Cards = digest.GeneratedCards
		view.OverflowCount = digest.OverflowCount
	case digest.SchemaVersion == 2:
		view.Receipts = digest.ReceiptItems
		view.ReceiptOverflow = digest.ReceiptOverflow
		view.DeliveryAlert = digest.DeliveryAlert
	default:
		view.Legacy = true
	}
	return view
}
