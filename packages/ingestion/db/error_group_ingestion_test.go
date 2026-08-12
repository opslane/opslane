package db_test

import (
	"context"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/db"
)

// TestInsertErrorEventAndGroupAtomic_NewGroup verifies that a single ingest call
// atomically creates an error event, an error group (status 'queued'), and a
// pending queue job, all linked together correctly.
func TestInsertErrorEventAndGroupAtomic_NewGroup(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)

	// Set up tenant hierarchy
	org, err := q.CreateOrg(ctx, "test-atomic-new")
	if err != nil {
		t.Fatalf("CreateOrg: %v", err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })

	proj, err := q.CreateProject(ctx, org.ID, "proj-atomic-new", ptrStr("org/repo"))
	if err != nil {
		t.Fatalf("CreateProject: %v", err)
	}

	env, err := q.CreateEnvironment(ctx, proj.ID, "production")
	if err != nil {
		t.Fatalf("CreateEnvironment: %v", err)
	}

	// Ingest a new error event
	result, err := q.InsertErrorEventAndGroup(ctx, db.IngestParams{
		ProjectID:            proj.ID,
		DefaultEnvironmentID: env.ID,
		ErrorType:            "TypeError",
		ErrorMessage:         "Cannot read properties of undefined",
		StackTraceRaw:        "at foo.js:1:1",
		Fingerprint:          "fp-atomic-new",
		Title:                "TypeError: Cannot read properties of undefined",
	})
	if err != nil {
		t.Fatalf("InsertErrorEventAndGroup: %v", err)
	}

	// Verify result fields are populated
	if result.EventID == "" {
		t.Fatal("expected non-empty EventID")
	}
	if result.GroupID == "" {
		t.Fatal("expected non-empty GroupID")
	}
	if result.JobID == "" {
		t.Fatal("expected non-empty JobID for new group")
	}
	if !result.IsNew {
		t.Fatal("expected IsNew = true for first occurrence")
	}

	// Verify the event was created with correct project and environment
	var eventProjectID, eventEnvID string
	err = pool.QueryRow(ctx,
		`SELECT project_id, environment_id FROM error_events WHERE id = $1`,
		result.EventID,
	).Scan(&eventProjectID, &eventEnvID)
	if err != nil {
		t.Fatalf("query event: %v", err)
	}
	if eventProjectID != proj.ID {
		t.Errorf("event.project_id = %q, want %q", eventProjectID, proj.ID)
	}
	if eventEnvID != env.ID {
		t.Errorf("event.environment_id = %q, want %q", eventEnvID, env.ID)
	}

	// Verify the error group was created with status 'queued' and occurrence_count = 1
	group, err := q.GetErrorGroup(ctx, proj.ID, result.GroupID)
	if err != nil {
		t.Fatalf("GetErrorGroup: %v", err)
	}
	if group == nil {
		t.Fatal("expected error group to exist")
	}
	if group.Status != "queued" {
		t.Errorf("group.status = %q, want %q", group.Status, "queued")
	}
	if group.OccurrenceCount != 1 {
		t.Errorf("group.occurrence_count = %d, want 1", group.OccurrenceCount)
	}

	// Verify the queue job was created with status 'pending'
	var jobStatus string
	err = pool.QueryRow(ctx,
		`SELECT status FROM error_group_jobs WHERE id = $1`,
		result.JobID,
	).Scan(&jobStatus)
	if err != nil {
		t.Fatalf("query job: %v", err)
	}
	if jobStatus != "pending" {
		t.Errorf("job.status = %q, want %q", jobStatus, "pending")
	}
}

// TestInsertErrorEventAndGroupAtomic_RecurringGroup verifies that ingesting
// two events with the same fingerprint reuses the existing group (bumping
// occurrence_count to 2) and does NOT create a second queue job.
func TestInsertErrorEventAndGroupAtomic_RecurringGroup(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)

	// Set up tenant hierarchy
	org, err := q.CreateOrg(ctx, "test-atomic-recur")
	if err != nil {
		t.Fatalf("CreateOrg: %v", err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })

	proj, err := q.CreateProject(ctx, org.ID, "proj-atomic-recur", ptrStr("org/repo"))
	if err != nil {
		t.Fatalf("CreateProject: %v", err)
	}

	env, err := q.CreateEnvironment(ctx, proj.ID, "production")
	if err != nil {
		t.Fatalf("CreateEnvironment: %v", err)
	}

	fingerprint := "fp-atomic-recur"

	// First ingest
	r1, err := q.InsertErrorEventAndGroup(ctx, db.IngestParams{
		ProjectID:            proj.ID,
		DefaultEnvironmentID: env.ID,
		ErrorType:            "ReferenceError",
		ErrorMessage:         "x is not defined",
		StackTraceRaw:        "at bar.js:10:5",
		Fingerprint:          fingerprint,
		Title:                "ReferenceError: x is not defined",
	})
	if err != nil {
		t.Fatalf("first InsertErrorEventAndGroup: %v", err)
	}
	if !r1.IsNew {
		t.Fatal("expected IsNew = true for first occurrence")
	}

	// Second ingest with same fingerprint
	r2, err := q.InsertErrorEventAndGroup(ctx, db.IngestParams{
		ProjectID:            proj.ID,
		DefaultEnvironmentID: env.ID,
		ErrorType:            "ReferenceError",
		ErrorMessage:         "x is not defined",
		StackTraceRaw:        "at bar.js:10:5",
		Fingerprint:          fingerprint,
		Title:                "ReferenceError: x is not defined",
	})
	if err != nil {
		t.Fatalf("second InsertErrorEventAndGroup: %v", err)
	}

	// isNew must be false on the second ingest
	if r2.IsNew {
		t.Fatal("expected IsNew = false for recurring group")
	}

	// Both events must exist
	if r1.EventID == r2.EventID {
		t.Fatal("expected two distinct event IDs")
	}
	for _, eid := range []string{r1.EventID, r2.EventID} {
		var exists bool
		err = pool.QueryRow(ctx,
			`SELECT EXISTS(SELECT 1 FROM error_events WHERE id = $1)`,
			eid,
		).Scan(&exists)
		if err != nil {
			t.Fatalf("check event %s: %v", eid, err)
		}
		if !exists {
			t.Errorf("event %s does not exist", eid)
		}
	}

	// Both results must reference the same group
	if r1.GroupID != r2.GroupID {
		t.Fatalf("expected same GroupID, got %q and %q", r1.GroupID, r2.GroupID)
	}

	// Only one group must exist for this fingerprint
	groups, err := q.ListErrorGroups(ctx, proj.ID, nil)
	if err != nil {
		t.Fatalf("ListErrorGroups: %v", err)
	}
	if len(groups) != 1 {
		t.Fatalf("expected 1 error group, got %d", len(groups))
	}

	// Occurrence count must be 2
	if groups[0].OccurrenceCount != 2 {
		t.Errorf("group.occurrence_count = %d, want 2", groups[0].OccurrenceCount)
	}

	// Second ingest must NOT have created a job (JobID should be empty)
	if r2.JobID != "" {
		t.Errorf("expected empty JobID on recurring event, got %q", r2.JobID)
	}

	// Total jobs for this group must be exactly 1 (from first ingest only)
	var jobCount int
	err = pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM error_group_jobs WHERE error_group_id = $1`,
		r1.GroupID,
	).Scan(&jobCount)
	if err != nil {
		t.Fatalf("count jobs: %v", err)
	}
	if jobCount != 1 {
		t.Errorf("job count = %d, want 1", jobCount)
	}

	// Group status must still be 'queued' (unchanged from first insert)
	group, err := q.GetErrorGroup(ctx, proj.ID, r1.GroupID)
	if err != nil {
		t.Fatalf("GetErrorGroup: %v", err)
	}
	if group.Status != "queued" {
		t.Errorf("group.status = %q, want %q", group.Status, "queued")
	}
}

// TestInsertErrorEventAndGroupAtomic_EnvironmentProjectMismatch verifies that
// ingesting with an environment_id that belongs to a different project is
// rejected, even when both IDs are valid UUIDs.
func TestInsertErrorEventAndGroupAtomic_EnvironmentProjectMismatch(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)

	org, err := q.CreateOrg(ctx, "test-env-mismatch")
	if err != nil {
		t.Fatalf("CreateOrg: %v", err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })

	projA, err := q.CreateProject(ctx, org.ID, "proj-A-mismatch", ptrStr("org/repo-a"))
	if err != nil {
		t.Fatalf("CreateProject A: %v", err)
	}
	projB, err := q.CreateProject(ctx, org.ID, "proj-B-mismatch", ptrStr("org/repo-b"))
	if err != nil {
		t.Fatalf("CreateProject B: %v", err)
	}
	// Environment belongs to project B
	envB, err := q.CreateEnvironment(ctx, projB.ID, "production")
	if err != nil {
		t.Fatalf("CreateEnvironment B: %v", err)
	}

	// Try to ingest into project A using project B's environment
	_, err = q.InsertErrorEventAndGroup(ctx, db.IngestParams{
		ProjectID:            projA.ID,
		DefaultEnvironmentID: envB.ID,
		ErrorType:            "TypeError",
		ErrorMessage:         "mismatch test",
		StackTraceRaw:        "at test.js:1:1",
		Fingerprint:          "fp-env-mismatch",
		Title:                "TypeError: mismatch test",
	})
	if err == nil {
		t.Fatal("expected error for environment-project mismatch, got nil")
	}
}

// TestInsertErrorEventAndGroupAtomic_CrossProjectIsolation verifies that the
// same fingerprint in two different projects produces two separate error groups,
// each visible only within its own project scope.
func TestInsertErrorEventAndGroupAtomic_CrossProjectIsolation(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)

	// Set up two projects under the same org
	org, err := q.CreateOrg(ctx, "test-atomic-isolation")
	if err != nil {
		t.Fatalf("CreateOrg: %v", err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })

	projA, err := q.CreateProject(ctx, org.ID, "proj-A", ptrStr("org/repo-a"))
	if err != nil {
		t.Fatalf("CreateProject A: %v", err)
	}
	envA, err := q.CreateEnvironment(ctx, projA.ID, "production")
	if err != nil {
		t.Fatalf("CreateEnvironment A: %v", err)
	}

	projB, err := q.CreateProject(ctx, org.ID, "proj-B", ptrStr("org/repo-b"))
	if err != nil {
		t.Fatalf("CreateProject B: %v", err)
	}
	envB, err := q.CreateEnvironment(ctx, projB.ID, "production")
	if err != nil {
		t.Fatalf("CreateEnvironment B: %v", err)
	}

	sharedFingerprint := "fp-cross-project"

	// Ingest into project A
	rA, err := q.InsertErrorEventAndGroup(ctx, db.IngestParams{
		ProjectID:            projA.ID,
		DefaultEnvironmentID: envA.ID,
		ErrorType:            "SyntaxError",
		ErrorMessage:         "Unexpected token",
		StackTraceRaw:        "at parse.js:5:3",
		Fingerprint:          sharedFingerprint,
		Title:                "SyntaxError: Unexpected token",
	})
	if err != nil {
		t.Fatalf("InsertErrorEventAndGroup A: %v", err)
	}

	// Ingest into project B with same fingerprint
	rB, err := q.InsertErrorEventAndGroup(ctx, db.IngestParams{
		ProjectID:            projB.ID,
		DefaultEnvironmentID: envB.ID,
		ErrorType:            "SyntaxError",
		ErrorMessage:         "Unexpected token",
		StackTraceRaw:        "at parse.js:5:3",
		Fingerprint:          sharedFingerprint,
		Title:                "SyntaxError: Unexpected token",
	})
	if err != nil {
		t.Fatalf("InsertErrorEventAndGroup B: %v", err)
	}

	// Must produce two separate groups (different IDs)
	if rA.GroupID == rB.GroupID {
		t.Fatal("expected different GroupIDs for different projects, got same")
	}

	// Both must be new groups
	if !rA.IsNew {
		t.Error("expected project A result IsNew = true")
	}
	if !rB.IsNew {
		t.Error("expected project B result IsNew = true")
	}

	// Project A should see only its own group
	groupsA, err := q.ListErrorGroups(ctx, projA.ID, nil)
	if err != nil {
		t.Fatalf("ListErrorGroups A: %v", err)
	}
	if len(groupsA) != 1 {
		t.Fatalf("project A: expected 1 group, got %d", len(groupsA))
	}
	if groupsA[0].ID != rA.GroupID {
		t.Errorf("project A group ID = %q, want %q", groupsA[0].ID, rA.GroupID)
	}

	// Project B should see only its own group
	groupsB, err := q.ListErrorGroups(ctx, projB.ID, nil)
	if err != nil {
		t.Fatalf("ListErrorGroups B: %v", err)
	}
	if len(groupsB) != 1 {
		t.Fatalf("project B: expected 1 group, got %d", len(groupsB))
	}
	if groupsB[0].ID != rB.GroupID {
		t.Errorf("project B group ID = %q, want %q", groupsB[0].ID, rB.GroupID)
	}

	// Each group should have occurrence_count = 1
	if groupsA[0].OccurrenceCount != 1 {
		t.Errorf("project A group occurrence_count = %d, want 1", groupsA[0].OccurrenceCount)
	}
	if groupsB[0].OccurrenceCount != 1 {
		t.Errorf("project B group occurrence_count = %d, want 1", groupsB[0].OccurrenceCount)
	}
}

// === Recurrence requeue policy tests ===

// helper: setupTenantAndIngest creates a tenant hierarchy, ingests one event, and returns
// the Queries handle, project, environment, result, and cleanup function context.
func setupTenantAndIngest(t *testing.T, orgName, fingerprint string) (
	*db.Queries, *db.Project, *db.Environment, *db.IngestResult,
) {
	t.Helper()
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)

	org, err := q.CreateOrg(ctx, orgName)
	if err != nil {
		t.Fatalf("CreateOrg: %v", err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })

	proj, err := q.CreateProject(ctx, org.ID, orgName+"-proj", ptrStr("org/repo"))
	if err != nil {
		t.Fatalf("CreateProject: %v", err)
	}

	env, err := q.CreateEnvironment(ctx, proj.ID, "production")
	if err != nil {
		t.Fatalf("CreateEnvironment: %v", err)
	}

	result, err := q.InsertErrorEventAndGroup(ctx, db.IngestParams{
		ProjectID:            proj.ID,
		DefaultEnvironmentID: env.ID,
		ErrorType:            "TypeError",
		ErrorMessage:         "test error",
		StackTraceRaw:        "at test.js:1:1",
		Fingerprint:          fingerprint,
		Title:                "TypeError: test error",
	})
	if err != nil {
		t.Fatalf("InsertErrorEventAndGroup: %v", err)
	}
	if !result.IsNew {
		t.Fatal("expected IsNew = true for first event")
	}

	return q, proj, env, result
}

// TestRequeueOnRecurrence_ResolvedGroup verifies that when a resolved group receives
// a new occurrence, the system creates a new job and sets status back to queued.
func TestRequeueOnRecurrence_ResolvedGroup(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	fingerprint := "fp-requeue-resolved"

	q, proj, env, r1 := setupTenantAndIngest(t, "test-requeue-resolved", fingerprint)

	// Manually move group to 'resolved' status
	err := q.UpdateErrorGroupStatus(ctx, db.StatusUpdate{
		ProjectID: proj.ID,
		GroupID:   r1.GroupID,
		Status:    "resolved",
	})
	if err != nil {
		t.Fatalf("UpdateErrorGroupStatus to resolved: %v", err)
	}

	// Verify group is resolved
	group, err := q.GetErrorGroup(ctx, proj.ID, r1.GroupID)
	if err != nil {
		t.Fatalf("GetErrorGroup: %v", err)
	}
	if group.Status != "resolved" {
		t.Fatalf("group.status = %q, want %q", group.Status, "resolved")
	}
	if _, err := pool.Exec(ctx, `INSERT INTO digest_readiness
		(incident_id, project_id, status, reason) VALUES ($1, $2, 'eligible', 'validated_cause')`,
		r1.GroupID, proj.ID); err != nil {
		t.Fatalf("seed readiness: %v", err)
	}

	// Second ingest with same fingerprint — should re-queue
	r2, err := q.InsertErrorEventAndGroup(ctx, db.IngestParams{
		ProjectID:            proj.ID,
		DefaultEnvironmentID: env.ID,
		ErrorType:            "TypeError",
		ErrorMessage:         "test error",
		StackTraceRaw:        "at test.js:1:1",
		Fingerprint:          fingerprint,
		Title:                "TypeError: test error",
	})
	if err != nil {
		t.Fatalf("second InsertErrorEventAndGroup: %v", err)
	}

	// Must NOT be new (same group)
	if r2.IsNew {
		t.Fatal("expected IsNew = false for recurring group")
	}

	// Must have created a new job
	if r2.JobID == "" {
		t.Fatal("expected non-empty JobID for re-queued group")
	}
	if !r2.Requeued {
		t.Fatal("expected Requeued = true")
	}

	// The new job must be different from the original
	if r2.JobID == r1.JobID {
		t.Error("expected different JobID for requeue vs original")
	}

	// Group status must be back to 'queued'
	group, err = q.GetErrorGroup(ctx, proj.ID, r1.GroupID)
	if err != nil {
		t.Fatalf("GetErrorGroup after requeue: %v", err)
	}
	if group.Status != "queued" {
		t.Errorf("group.status = %q, want %q", group.Status, "queued")
	}

	// Occurrence count must be 2
	if group.OccurrenceCount != 2 {
		t.Errorf("group.occurrence_count = %d, want 2", group.OccurrenceCount)
	}
	var readinessStatus, readinessReason string
	if err := pool.QueryRow(ctx, `SELECT status, reason FROM digest_readiness WHERE incident_id=$1`, r1.GroupID).
		Scan(&readinessStatus, &readinessReason); err != nil {
		t.Fatalf("read readiness: %v", err)
	}
	if readinessStatus != "pending" || readinessReason != "reinvestigating" {
		t.Fatalf("readiness = %s/%s, want pending/reinvestigating", readinessStatus, readinessReason)
	}

	// Total jobs for this group: 2 (original + requeue)
	var jobCount int
	err = pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM error_group_jobs WHERE error_group_id = $1`,
		r1.GroupID,
	).Scan(&jobCount)
	if err != nil {
		t.Fatalf("count jobs: %v", err)
	}
	if jobCount != 2 {
		t.Errorf("job count = %d, want 2", jobCount)
	}
}

// TestRequeueOnRecurrence_NeedsHumanRetriable verifies that a needs_human group
// with a retriable reason code (e.g. missing_llm_key) gets re-queued on recurrence.
func TestRequeueOnRecurrence_NeedsHumanRetriable(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	fingerprint := "fp-requeue-nh-retriable"

	q, proj, env, r1 := setupTenantAndIngest(t, "test-requeue-nh-retriable", fingerprint)

	// Manually move group to needs_human with a retriable reason code
	reasonCode := "missing_llm_key"
	reasonMsg := "Anthropic API key not configured"
	remediation := "Add ANTHROPIC_API_KEY to project secrets"
	err := q.UpdateErrorGroupStatus(ctx, db.StatusUpdate{
		ProjectID:     proj.ID,
		GroupID:       r1.GroupID,
		Status:        "needs_human",
		ReasonCode:    &reasonCode,
		ReasonMessage: &reasonMsg,
		Remediation:   &remediation,
	})
	if err != nil {
		t.Fatalf("UpdateErrorGroupStatus to needs_human: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE error_groups
		 SET verification_evidence = '{"version":1,"tier":"E0","checks":[]}'::jsonb,
		     candidate_diff = 'diff --git a/src/a.ts b/src/a.ts'
		 WHERE id = $1`, r1.GroupID); err != nil {
		t.Fatalf("seed stale verification proof: %v", err)
	}

	// Second ingest with same fingerprint — should re-queue (retriable reason)
	r2, err := q.InsertErrorEventAndGroup(ctx, db.IngestParams{
		ProjectID:            proj.ID,
		DefaultEnvironmentID: env.ID,
		ErrorType:            "TypeError",
		ErrorMessage:         "test error",
		StackTraceRaw:        "at test.js:1:1",
		Fingerprint:          fingerprint,
		Title:                "TypeError: test error",
	})
	if err != nil {
		t.Fatalf("second InsertErrorEventAndGroup: %v", err)
	}

	// Must have created a new job
	if r2.JobID == "" {
		t.Fatal("expected non-empty JobID for re-queued needs_human group with retriable reason")
	}
	if !r2.Requeued {
		t.Fatal("expected Requeued = true")
	}

	// Group status must be back to 'queued'
	group, err := q.GetErrorGroup(ctx, proj.ID, r1.GroupID)
	if err != nil {
		t.Fatalf("GetErrorGroup: %v", err)
	}
	if group.Status != "queued" {
		t.Errorf("group.status = %q, want %q", group.Status, "queued")
	}

	// Reason fields must be cleared after requeue
	if group.ReasonCode != nil {
		t.Errorf("group.reason_code = %q, want nil (cleared on requeue)", *group.ReasonCode)
	}
	if group.ReasonMessage != nil {
		t.Errorf("group.reason_message = %q, want nil (cleared on requeue)", *group.ReasonMessage)
	}
	if group.Remediation != nil {
		t.Errorf("group.remediation = %q, want nil (cleared on requeue)", *group.Remediation)
	}
	if len(group.VerificationEvidence) != 0 {
		t.Errorf("group.verification_evidence = %s, want nil (cleared on requeue)", group.VerificationEvidence)
	}
	if group.CandidateDiff != nil {
		t.Errorf("group.candidate_diff = %q, want nil (cleared on requeue)", *group.CandidateDiff)
	}
	// Requeue upserts the projection row (C4): an absent-row incident (skipped by
	// the 047 backfill, or a pre-flight failure that wrote no outcome) must enter
	// the projection as pending/reinvestigating rather than stay permanently
	// invisible to the eligible-only digest gate. C1's absent-row rendering
	// policy that the old zero-row pin protected was retired by migration 047.
	var readinessStatus, readinessReason string
	if err := pool.QueryRow(ctx,
		`SELECT status, reason FROM digest_readiness WHERE incident_id=$1`, r1.GroupID,
	).Scan(&readinessStatus, &readinessReason); err != nil {
		t.Fatalf("read readiness after requeue: %v", err)
	}
	if readinessStatus != "pending" || readinessReason != "reinvestigating" {
		t.Fatalf("requeued absent-row group readiness = (%q,%q), want (pending,reinvestigating)", readinessStatus, readinessReason)
	}

	// Occurrence count must be 2
	if group.OccurrenceCount != 2 {
		t.Errorf("group.occurrence_count = %d, want 2", group.OccurrenceCount)
	}

	// Total jobs: 2 (original + requeue)
	var jobCount int
	err = pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM error_group_jobs WHERE error_group_id = $1`,
		r1.GroupID,
	).Scan(&jobCount)
	if err != nil {
		t.Fatalf("count jobs: %v", err)
	}
	if jobCount != 2 {
		t.Errorf("job count = %d, want 2", jobCount)
	}
}

// TestNoRequeueOnRecurrence_NeedsHumanNonRetriable verifies that a needs_human
// group with a non-retriable reason code (policy_blocked, auth_invalid) does NOT
// get re-queued on recurrence.
func TestNoRequeueOnRecurrence_NeedsHumanNonRetriable(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()

	nonRetriableCodes := []string{"policy_blocked", "auth_invalid"}

	for _, code := range nonRetriableCodes {
		t.Run(code, func(t *testing.T) {
			fingerprint := "fp-no-requeue-" + code

			q, proj, env, r1 := setupTenantAndIngest(t, "test-no-requeue-"+code, fingerprint)

			// Manually move group to needs_human with a non-retriable reason code
			reasonCode := code
			reasonMsg := "Non-retriable failure: " + code
			remediation := "Contact support"
			err := q.UpdateErrorGroupStatus(ctx, db.StatusUpdate{
				ProjectID:     proj.ID,
				GroupID:       r1.GroupID,
				Status:        "needs_human",
				ReasonCode:    &reasonCode,
				ReasonMessage: &reasonMsg,
				Remediation:   &remediation,
			})
			if err != nil {
				t.Fatalf("UpdateErrorGroupStatus to needs_human: %v", err)
			}

			// Second ingest with same fingerprint — should NOT re-queue
			r2, err := q.InsertErrorEventAndGroup(ctx, db.IngestParams{
				ProjectID:            proj.ID,
				DefaultEnvironmentID: env.ID,
				ErrorType:            "TypeError",
				ErrorMessage:         "test error",
				StackTraceRaw:        "at test.js:1:1",
				Fingerprint:          fingerprint,
				Title:                "TypeError: test error",
			})
			if err != nil {
				t.Fatalf("second InsertErrorEventAndGroup: %v", err)
			}

			// Must NOT have created a new job
			if r2.JobID != "" {
				t.Errorf("expected empty JobID for non-retriable needs_human, got %q", r2.JobID)
			}
			if r2.Requeued {
				t.Error("expected Requeued = false for non-retriable reason code")
			}

			// Group status must remain 'needs_human'
			group, err := q.GetErrorGroup(ctx, proj.ID, r1.GroupID)
			if err != nil {
				t.Fatalf("GetErrorGroup: %v", err)
			}
			if group.Status != "needs_human" {
				t.Errorf("group.status = %q, want %q", group.Status, "needs_human")
			}

			// Reason fields must still be set
			if group.ReasonCode == nil || *group.ReasonCode != code {
				t.Errorf("group.reason_code = %v, want %q", group.ReasonCode, code)
			}

			// Occurrence count must still be 2 (event was recorded)
			if group.OccurrenceCount != 2 {
				t.Errorf("group.occurrence_count = %d, want 2", group.OccurrenceCount)
			}

			// Total jobs: exactly 1 (only the original, no requeue)
			var jobCount int
			err = pool.QueryRow(ctx,
				`SELECT COUNT(*) FROM error_group_jobs WHERE error_group_id = $1`,
				r1.GroupID,
			).Scan(&jobCount)
			if err != nil {
				t.Fatalf("count jobs: %v", err)
			}
			if jobCount != 1 {
				t.Errorf("job count = %d, want 1", jobCount)
			}
		})
	}
}

// TestNoRequeueOnRecurrence_ActiveStates verifies that groups in active processing
// states (queued, analyzing, pr_created, pr_draft) do NOT get double-queued on recurrence.
func TestNoRequeueOnRecurrence_ActiveStates(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()

	activeStates := []string{"queued", "analyzing", "pr_created", "pr_draft"}

	for _, status := range activeStates {
		t.Run(status, func(t *testing.T) {
			fingerprint := "fp-no-requeue-active-" + status

			q, proj, env, r1 := setupTenantAndIngest(t, "test-no-requeue-"+status, fingerprint)

			// For non-'queued' active states, manually update the status
			// (queued is already the default after first ingest)
			if status != "queued" {
				_, err := pool.Exec(ctx,
					`UPDATE error_groups SET status = $1::error_group_status WHERE id = $2`,
					status, r1.GroupID,
				)
				if err != nil {
					t.Fatalf("update group status to %s: %v", status, err)
				}
			}

			// Second ingest with same fingerprint — should NOT re-queue
			r2, err := q.InsertErrorEventAndGroup(ctx, db.IngestParams{
				ProjectID:            proj.ID,
				DefaultEnvironmentID: env.ID,
				ErrorType:            "TypeError",
				ErrorMessage:         "test error",
				StackTraceRaw:        "at test.js:1:1",
				Fingerprint:          fingerprint,
				Title:                "TypeError: test error",
			})
			if err != nil {
				t.Fatalf("second InsertErrorEventAndGroup: %v", err)
			}

			// Must NOT have created a new job
			if r2.JobID != "" {
				t.Errorf("expected empty JobID for active state %q, got %q", status, r2.JobID)
			}
			if r2.Requeued {
				t.Errorf("expected Requeued = false for active state %q", status)
			}

			// Total jobs: exactly 1 (only the original)
			var jobCount int
			err = pool.QueryRow(ctx,
				`SELECT COUNT(*) FROM error_group_jobs WHERE error_group_id = $1`,
				r1.GroupID,
			).Scan(&jobCount)
			if err != nil {
				t.Fatalf("count jobs: %v", err)
			}
			if jobCount != 1 {
				t.Errorf("job count = %d, want 1 for active state %q", jobCount, status)
			}

			// Occurrence count must be 2 (event was still recorded)
			group, err := q.GetErrorGroup(ctx, proj.ID, r1.GroupID)
			if err != nil {
				t.Fatalf("GetErrorGroup: %v", err)
			}
			if group.OccurrenceCount != 2 {
				t.Errorf("group.occurrence_count = %d, want 2", group.OccurrenceCount)
			}
		})
	}
}
