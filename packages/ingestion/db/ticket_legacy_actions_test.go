package db_test

import (
	"context"
	"errors"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/db"
)

func TestTicketRejectsLegacyActionsWithoutChangingPublication(t *testing.T) {
	for _, activeFix := range []bool{false, true} {
		name := "ready"
		if activeFix {
			name = "active fix"
		}
		t.Run(name, func(t *testing.T) {
			f := seedTicketFix(t)
			ctx := context.Background()
			if activeFix {
				if _, err := f.q.TriggerFixJob(ctx, f.project, f.group, ""); err != nil {
					t.Fatal(err)
				}
			}
			snapshot := func() string {
				t.Helper()
				var state string
				err := f.q.Pool().QueryRow(ctx, `SELECT jsonb_build_object(
      'group',to_jsonb(g),'ticket',to_jsonb(t),
      'jobs',(SELECT jsonb_agg(to_jsonb(j) ORDER BY j.id) FROM error_group_jobs j WHERE j.error_group_id=g.id),
      'attempts',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM friction_fix_attempts a WHERE a.ticket_id=t.id))::text
      FROM error_groups g JOIN friction_tickets t ON t.id=g.ticket_id WHERE g.id=$1 AND g.project_id=$2`, f.group, f.project).Scan(&state)
				if err != nil {
					t.Fatal(err)
				}
				return state
			}
			before := snapshot()
			for _, action := range []struct {
				name string
				run  func() error
			}{
				{"link PR", func() error {
					return f.q.LinkPR(ctx, f.project, f.group, "https://github.com/org/repo/pull/77", "org/repo", 77)
				}},
				{"resolve", func() error { return f.q.ResolveErrorGroup(ctx, f.project, f.group) }},
			} {
				t.Run(action.name, func(t *testing.T) {
					if err := action.run(); !errors.Is(err, db.ErrTicketLegacyAction) {
						t.Errorf("expected known-problem refusal, got %v", err)
					}
					if after := snapshot(); after != before {
						t.Error("rejected legacy action changed publication, ticket, jobs, or attempts")
					}
				})
			}
			// A project-scoped refusal must not disclose another tenant's ticket.
			if err := f.q.LinkPR(ctx, "00000000-0000-4000-8000-000000000001", f.group, "https://github.com/org/repo/pull/77", "org/repo", 77); !errors.Is(err, db.ErrIncidentNotFound) {
				t.Fatalf("foreign ticket: %v", err)
			}
		})
	}
}
