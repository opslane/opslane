package digest

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

// The window fix is only worth anything if Build uses it. Every other window
// test calls windowFor directly, so replacing the call in Build with a fixed
// trailing 24h would leave them all green while the reported gap came back.
// This drives the whole path: a prior delivered digest, an item that falls in
// the recovered gap, and the published payload.
func TestBuildCoversTheGapLeftByALateRun(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	f := seedDigestFixture(t, pool, now)

	// The previous digest stopped 30h ago, so 30h..24h ago belongs to no
	// digest under a trailing 24h and is exactly what must be recovered.
	previousEnd := now.Add(-30 * time.Hour)
	clearDigestEvents(t, pool, f.ProjectID)
	seedPriorDigest(t, pool, f.ProjectID, previousEnd, "build-gap-case")

	// Ready 28h ago: inside the recovered gap, outside a trailing 24h. Last
	// seen recently so the liveness bound cannot be what admits or drops it.
	var groupID string
	if err := pool.QueryRow(ctx, `INSERT INTO error_groups
		(project_id,environment_id,fingerprint,title,kind,status,first_seen,last_seen,
		 occurrence_count,affected_users_count,pr_created_at,pr_url)
		VALUES ($1,$2,$3,'Recovered from the gap','error','pr_created',$4,$5,3,2,$6,$7)
		RETURNING id`, f.ProjectID, f.EnvID, "gap-"+uuid.NewString(),
		now.Add(-40*time.Hour), now.Add(-time.Hour), now.Add(-28*time.Hour),
		"https://github.example/pr/gap").Scan(&groupID); err != nil {
		t.Fatal(err)
	}
	setPipelineState(t, pool, f.ProjectID, groupID, "eligible", now.Add(-28*time.Hour))

	payload, err := New(pool, "https://dash.example").Build(ctx, f.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}

	from, err := time.Parse(time.RFC3339Nano, payload.Digest.Window.From)
	if err != nil {
		t.Fatalf("published window.from %q: %v", payload.Digest.Window.From, err)
	}
	if !from.UTC().Equal(previousEnd) {
		t.Errorf("published window.from = %s; want the previous watermark %s", from.UTC(), previousEnd)
	}

	var found bool
	for _, item := range payload.Digest.ReceiptItems {
		if item.IncidentID == groupID {
			found = true
		}
	}
	if !found {
		t.Error("an item ready 28h ago was not reported; the gap a late run leaves is still open")
	}
}
