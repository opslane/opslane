package notify

// DigestView is the one shared interpretation of a stored digest payload.
// Every non-Slack consumer (MCP, read API, digest-eval) builds its rendering
// from this view instead of plucking fields, so the channels cannot disagree
// about what a digest contains. Slack's per-version renderers are a delivery
// compatibility surface and stay independent.
type DigestView struct {
	MergedThisWeek  []DigestPRMerged
	Date            string
	Cards           []GeneratedDigestCard
	Receipts        []ReceiptItem
	ReceiptOverflow int
	OverflowCount   int
	DeliveryAlert   string
	SchemaVersion   int
	// Legacy is true only for v1 payloads (schema_version absent). Those
	// carry no cards or receipts, but they do carry insights and issue
	// lists that the Slack v1 renderer shows, so the view reports them as
	// unreadable rather than as empty. v2 and v3 map their lane into the
	// view so stored pre-v4 digests keep rendering everywhere.
	Legacy bool
}

// Empty reports whether the digest contained nothing to act on. Deferred
// items count: a digest whose whole content overflowed the render cap has
// something waiting on the dashboard and must not be reported as quiet.
func (v DigestView) Empty() bool {
	// A legacy payload is not empty, it is unreadable to this view: v1
	// digests carry insights and issue lists the Slack v1 renderer still
	// shows. Reporting empty here would tell a customer nothing was
	// delivered on a day something was.
	if v.Legacy {
		return false
	}
	return len(v.Cards) == 0 && len(v.Receipts) == 0 && v.DeliveryAlert == "" &&
		v.ReceiptOverflow == 0 && v.OverflowCount == 0 && len(v.MergedThisWeek) == 0
}

// BuildDigestView maps every stored digest version into the shared view.
func BuildDigestView(digest *DigestPayload) DigestView {
	if digest == nil {
		return DigestView{}
	}
	view := DigestView{Date: digest.Date, SchemaVersion: digest.SchemaVersion, MergedThisWeek: digest.MergedThisWeek}
	// Version mapping mirrors the Slack renderer switch (slack_digest.go):
	// v4 carries cards + receipts; v3 carried cards; v2 carried receipts;
	// v1 (schema_version 0/1) has neither and is reported as Legacy.
	switch {
	case digest.SchemaVersion >= 4:
		view.Cards = cardsWithoutSignedActions(digest.GeneratedCards)
		view.Receipts = renderableReceiptItems(digest)
		view.ReceiptOverflow = digest.ReceiptOverflow
		view.OverflowCount = digest.OverflowCount
		view.DeliveryAlert = digest.DeliveryAlert
	case digest.SchemaVersion == 3:
		view.Cards = digest.GeneratedCards
		view.OverflowCount = digest.OverflowCount
	case digest.SchemaVersion == 2:
		view.Receipts = renderableReceiptItems(digest)
		view.ReceiptOverflow = digest.ReceiptOverflow
		view.DeliveryAlert = digest.DeliveryAlert
	default:
		view.Legacy = true
	}
	return view
}

// renderableReceiptItems applies the same admission rule the Slack renderer
// uses, so a receipt Slack drops (an unknown kind, or a state with no
// narrative line) cannot appear in the MCP tool or the read API. Without
// this the view would reintroduce the divergence it exists to remove.
func renderableReceiptItems(digest *DigestPayload) []ReceiptItem {
	if digest.SchemaVersion >= 5 {
		if len(digest.ReceiptItems) == 0 {
			return nil
		}
		items := make([]ReceiptItem, 0, len(digest.ReceiptItems))
		for _, item := range digest.ReceiptItems {
			item.ActionURL, item.LatestAttemptID = "", ""
			items = append(items, item)
		}
		return items
	}
	renderable := renderableDigestReceipts(digest)
	if len(renderable) == 0 {
		return nil
	}
	items := make([]ReceiptItem, 0, len(renderable))
	for _, entry := range renderable {
		items = append(items, entry.item)
	}
	return items
}

// cardsWithoutSignedActions copies cards without their signed fix links. The
// intent is a credential for the Slack delivery, which renders from the stored
// digest; the read API and the MCP tool must not hand it out.
func cardsWithoutSignedActions(cards []GeneratedDigestCard) []GeneratedDigestCard {
	if len(cards) == 0 {
		return cards
	}
	copied := make([]GeneratedDigestCard, 0, len(cards))
	for _, card := range cards {
		card.ActionURL = ""
		copied = append(copied, card)
	}
	return copied
}
