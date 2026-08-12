package db_test

import (
	"context"
	"strings"
	"testing"
)

func TestMigration046ImpactQueryIndexes(t *testing.T) {
	admin := testPool(t)
	psql := findPsql(t)
	pool, dsn := disposableDB(t, admin)
	for _, file := range migrationFiles(t) {
		if err := applyMigration(t, psql, dsn, file); err != nil {
			t.Fatalf("apply %s: %v", file, err)
		}
	}

	tests := []struct {
		name       string
		wantCols   string
		predicates []string
	}{
		{
			name:       "idx_error_events_group_timestamp",
			wantCols:   `(error_group_id, "timestamp")`,
			predicates: []string{"session_id IS NOT NULL"},
		},
		{
			name:     "idx_friction_signals_incident_occurred",
			wantCols: "(incident_id, occurred_at)",
			predicates: []string{
				"incident_id IS NOT NULL",
				"superseded_by IS NULL",
				"retracted_at IS NULL",
				"adjudication_status = 'accepted'::text",
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var def string
			if err := pool.QueryRow(context.Background(),
				`SELECT indexdef FROM pg_indexes WHERE tablename = CASE WHEN $1 LIKE 'idx_error_events%' THEN 'error_events' ELSE 'friction_signals' END AND indexname = $1`,
				tt.name,
			).Scan(&def); err != nil {
				t.Fatalf("index missing: %v", err)
			}
			if !strings.Contains(def, tt.wantCols) {
				t.Fatalf("indexdef %q missing ordered columns %s", def, tt.wantCols)
			}
			for _, predicate := range tt.predicates {
				if !strings.Contains(def, predicate) {
					t.Fatalf("indexdef %q missing predicate %q", def, predicate)
				}
			}
		})
	}
}
