package db_test

import (
	"context"
	"fmt"
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

func TestTicketDigestFactsRepresentativeReplayAnchor(t *testing.T) {
	f := seedTicketFix(t)
	ctx := context.Background()
	pool := f.q.Pool()
	representative := f.ticket + "-1"
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	epochMs := func(sql string, args ...any) int64 {
		t.Helper()
		var ms int64
		if err := pool.QueryRow(ctx, sql, args...).Scan(&ms); err != nil {
			t.Fatal(err)
		}
		return ms
	}
	loadFacts := func() *db.TicketDigestFacts {
		t.Helper()
		facts, err := db.LoadTicketDigestFacts(ctx, pool, f.project, f.group, time.Now())
		if err != nil || facts == nil || facts.RepresentativeSessionID != representative {
			t.Fatalf("facts=%+v error=%v", facts, err)
		}
		return facts
	}
	load := func() *db.TicketDigestFacts {
		t.Helper()
		facts := loadFacts()
		if err := db.LoadTicketReplayAnchor(ctx, pool, f.project, facts); err != nil {
			t.Fatalf("anchor error=%v", err)
		}
		return facts
	}
	attempt := ""
	if err := pool.QueryRow(ctx, `SELECT attempt_id::text FROM friction_checks WHERE ticket_id=$1 AND session_id=$2`, f.ticket, representative).Scan(&attempt); err != nil {
		t.Fatal(err)
	}
	cite := func(lines string) {
		t.Helper()
		exec(`UPDATE friction_check_attempts SET evidence_lines=$2::jsonb WHERE id=$1`, attempt, lines)
	}
	// The recording started five hours ago so every seeded signal lies inside it.
	exec(`UPDATE sessions SET started_at=now()-interval '5 hours' WHERE id=$1`, representative)
	// The representative check verified two signals; the earlier one is cited
	// second. A third, even earlier signal was matched but not verified by the
	// check, and a fourth belongs to the session without being matched at all.
	var verifiedEarly, unverified, unmatched string
	for _, s := range []struct {
		dest   *string
		offset string
	}{{&verifiedEarly, "2 hours"}, {&unverified, "3 hours"}, {&unmatched, "4 hours"}} {
		if err := pool.QueryRow(ctx, `INSERT INTO friction_signals(session_id,project_id,environment_id,rule_version,signal_type,fingerprint,page_url_normalized,occurred_at,observation_id,narrative_id)
			SELECT id,project_id,environment_id,3,'other',id||$2::text,'/pay',now()-$2::text::interval,'o'||$2::text,'n' FROM sessions WHERE id=$1 RETURNING id`, representative, s.offset).Scan(s.dest); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO friction_ticket_match_observations(ticket_id,session_id,signal_id) VALUES($1,$2,$3),($1,$2,$4)`, f.ticket, representative, verifiedEarly, unverified)
	// An even earlier signal that belongs to another session's match is listed in
	// the representative attempt but is not that session's verified evidence.
	var otherSession string
	if err := pool.QueryRow(ctx, `INSERT INTO friction_signals(session_id,project_id,environment_id,rule_version,signal_type,fingerprint,page_url_normalized,occurred_at,observation_id,narrative_id)
		SELECT id,project_id,environment_id,3,'other',id||'-other','/pay',now()-interval '4 hours 30 minutes','o-other','n' FROM sessions WHERE id=$1 RETURNING id`, f.ticket+"-0").Scan(&otherSession); err != nil {
		t.Fatal(err)
	}
	exec(`INSERT INTO friction_ticket_match_observations(ticket_id,session_id,signal_id) VALUES($1,$2,$3)`, f.ticket, f.ticket+"-0", otherSession)
	exec(`UPDATE friction_check_attempts SET signal_ids=jsonb_build_array($2::text,$3::text,$4::text) WHERE id=$1`, attempt, f.signals[1], verifiedEarly, otherSession)
	wantSignal := epochMs(`SELECT (extract(epoch FROM occurred_at)*1000)::bigint FROM friction_signals WHERE id=$1`, verifiedEarly)
	// The loader records the fallback but leaves the anchor to LoadTicketReplayAnchor.
	if facts := loadFacts(); facts.RepresentativeSignalMs != wantSignal || facts.RepresentativeAnchorMs != 0 || facts.RepresentativeAttemptID != attempt {
		t.Fatalf("facts signal=%d anchor=%d attempt=%q want %d, 0, %q", facts.RepresentativeSignalMs, facts.RepresentativeAnchorMs, facts.RepresentativeAttemptID, wantSignal, attempt)
	}
	if facts := load(); facts.RepresentativeAnchorMs != wantSignal {
		t.Fatalf("signal fallback anchor=%d want earliest verified %d", facts.RepresentativeAnchorMs, wantSignal)
	}
	// With an ok narrative, the anchor is the earliest cited, timed, non-idle line.
	startMs := epochMs(`SELECT (extract(epoch FROM started_at)*1000)::bigint FROM sessions WHERE id=$1`, representative)
	moment := startMs + 871_000
	timeline := fmt.Sprintf(`{"startTs":%d,"lines":[{"t":"open","s":null,"r":"/pay","a":%d},{"t":"idle","s":null,"r":"/pay","a":%d,"k":"idle"},{"t":"click Pay","s":"#pay","r":"/pay","a":%d},{"t":"spinner","s":null,"r":"/pay","a":%d}]}`, startMs, startMs+1_000, startMs+2_000, moment, moment+4_000)
	exec(`INSERT INTO session_narratives(session_id,project_id,environment_id,status,narrative,timeline,prompt_version)
		SELECT id,project_id,environment_id,'ok','{}'::jsonb,$2::jsonb,1 FROM sessions WHERE id=$1`, representative, timeline)
	cite(`["L4","L2","L3"]`)
	if facts := load(); facts.RepresentativeAnchorMs != moment || facts.RepresentativeAnchorMs < startMs {
		t.Fatalf("timeline anchor=%d want %d", facts.RepresentativeAnchorMs, moment)
	}
	// A staging attempt for the same session citing an earlier line is not the finalized check.
	job := ""
	if err := pool.QueryRow(ctx, `INSERT INTO error_group_jobs(project_id,error_group_id,job_type,status,ticket_id,publication_generation,source_id)
		VALUES($1,$2,'friction_confirm','completed',$3,1,$2) RETURNING id`, f.project, f.group, f.ticket).Scan(&job); err != nil {
		t.Fatal(err)
	}
	staging := ""
	if err := pool.QueryRow(ctx, `INSERT INTO friction_confirm_batches(ticket_id,job_id,manifest,arrival_boundary_at_select,live_generation_at_select,status_at_select,status)
		VALUES($1,$2,'[]',4,1,'tracking','staging') RETURNING id`, f.ticket, job).Scan(&staging); err != nil {
		t.Fatal(err)
	}
	exec(`INSERT INTO friction_check_attempts(batch_id,ticket_id,session_id,outcome,evidence_lines,signal_ids,note,model)
		VALUES($1,$2,$3,'confirmed','["L1"]',jsonb_build_array($4::text),'Opened payment','test')`, staging, f.ticket, representative, verifiedEarly)
	if facts := load(); facts.RepresentativeAnchorMs != moment {
		t.Fatalf("staging attempt anchor=%d want finalized %d", facts.RepresentativeAnchorMs, moment)
	}
	// Null elements are ignored; a non-array value degrades to the signal time.
	cite(`[null,"L3"]`)
	if facts := load(); facts.RepresentativeAnchorMs != moment {
		t.Fatalf("null citation anchor=%d want %d", facts.RepresentativeAnchorMs, moment)
	}
	for _, malformed := range []string{`{"L3":1}`, `"L3"`, `null`} {
		cite(malformed)
		if facts := load(); facts.RepresentativeAnchorMs != wantSignal {
			t.Fatalf("malformed %s anchor=%d want %d", malformed, facts.RepresentativeAnchorMs, wantSignal)
		}
	}
	// Citations that resolve to nothing fall back to the verified signal.
	cite(`["L2","L9"]`)
	if facts := load(); facts.RepresentativeAnchorMs != wantSignal {
		t.Fatalf("unresolvable citation anchor=%d want %d", facts.RepresentativeAnchorMs, wantSignal)
	}
	// An attempt purged after the facts were read degrades instead of failing.
	purged := loadFacts()
	purged.RepresentativeAttemptID = "00000000-0000-0000-0000-000000000000"
	if err := db.LoadTicketReplayAnchor(ctx, pool, f.project, purged); err != nil || purged.RepresentativeAnchorMs != wantSignal {
		t.Fatalf("purged attempt anchor=%d error=%v want %d", purged.RepresentativeAnchorMs, err, wantSignal)
	}
	// Another project cannot read this ticket's attempt.
	scoped := loadFacts()
	if err := db.LoadTicketReplayAnchor(ctx, pool, "00000000-0000-0000-0000-000000000000", scoped); err != nil || scoped.RepresentativeAnchorMs != wantSignal {
		t.Fatalf("cross-project anchor=%d error=%v want %d", scoped.RepresentativeAnchorMs, err, wantSignal)
	}
	// A non-ok narrative is not evidence either.
	cite(`["L3"]`)
	exec(`UPDATE session_narratives SET status='failed',narrative=NULL WHERE session_id=$1`, representative)
	if facts := load(); facts.RepresentativeAnchorMs != wantSignal {
		t.Fatalf("failed narrative anchor=%d want %d", facts.RepresentativeAnchorMs, wantSignal)
	}
	// With neither a resolvable citation nor a verified signal, the link starts at 0.
	exec(`UPDATE friction_check_attempts SET signal_ids='[]' WHERE id=$1`, attempt)
	if facts := load(); facts.RepresentativeAnchorMs != 0 || facts.RepresentativeSignalMs != 0 {
		t.Fatalf("no evidence anchor=%d signal=%d want 0", facts.RepresentativeAnchorMs, facts.RepresentativeSignalMs)
	}
}
