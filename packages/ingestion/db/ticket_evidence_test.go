package db_test

import (
	"context"
	"github.com/opslane/opslane/packages/ingestion/db"
	"testing"
	"time"
)

func TestTicketDigestFactsUsesFinalizedCurrentEvidence(t *testing.T) {
	f := seedTicketFix(t)
	ctx := context.Background()
	facts, err := db.LoadTicketDigestFacts(ctx, f.q.Pool(), f.project, f.group, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if facts == nil || facts.VerifiedSessions != 4 || facts.Coverage != 0.5 || len(facts.SignalIDs) != 4 || facts.RepresentativeSessionID != f.ticket+"-1" {
		t.Fatalf("facts=%+v", facts)
	}
	// Coverage is a set intersection even if stored explanation IDs repeat.
	if _, err := f.q.Pool().Exec(ctx, `UPDATE error_groups SET explained_signal_ids=jsonb_build_array($2::text,$2::text,$3::text) WHERE id=$1`, f.group, f.signals[0], f.signals[1]); err != nil {
		t.Fatal(err)
	}
	facts, err = db.LoadTicketDigestFacts(ctx, f.q.Pool(), f.project, f.group, time.Now())
	if err != nil || facts.Coverage != .5 {
		t.Fatalf("duplicate explanation coverage=%+v error=%v", facts, err)
	}
	// Moving the evaluation clock excludes evidence outside this exact seven-day window.
	facts, err = db.LoadTicketDigestFacts(ctx, f.q.Pool(), f.project, f.group, time.Now().Add(8*24*time.Hour))
	if err != nil || facts.VerifiedSessions != 0 || facts.Coverage != 0 {
		t.Fatalf("expired facts=%+v error=%v", facts, err)
	}
	facts, err = db.LoadTicketDigestFacts(ctx, f.q.Pool(), f.project, f.group, time.Now().Add(-2*time.Hour))
	if err != nil || facts.VerifiedSessions != 0 {
		t.Fatalf("future facts=%+v error=%v", facts, err)
	}
}
