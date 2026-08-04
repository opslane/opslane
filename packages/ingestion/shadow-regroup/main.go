// Command shadow-regroup classifies stored events under the slice-1 grouping
// ladder without writing and prints a deterministic per-project cutover preview.
// Run it from the same revision that is deployed.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"sort"

	"github.com/jackc/pgx/v5"
)

type projectList []string

func (projects *projectList) String() string { return fmt.Sprint(*projects) }

func (projects *projectList) Set(value string) error {
	*projects = append(*projects, value)
	return nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "shadow-regroup: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	var projects projectList
	flag.Var(&projects, "project", "project UUID to include (repeatable, required)")
	flag.Parse()
	if len(projects) == 0 {
		return fmt.Errorf("--project <uuid> is required (repeatable); there is deliberately no all-projects mode")
	}
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		return fmt.Errorf("DATABASE_URL is required")
	}

	ctx := context.Background()
	conn, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, "SET default_transaction_read_only = on"); err != nil {
		return fmt.Errorf("session setup: %w", err)
	}
	if _, err := conn.Exec(ctx, "SET statement_timeout = '120s'"); err != nil {
		return fmt.Errorf("session setup: %w", err)
	}

	databaseRows, err := conn.Query(ctx, `
		SELECT e.project_id::text, e.error_group_id::text, e.platform,
		       e.error_message, e.stack_trace_raw
		FROM error_events e
		WHERE e.error_group_id IS NOT NULL AND e.project_id = ANY($1::uuid[])
		ORDER BY e.project_id, e.error_group_id, e.id`, []string(projects))
	if err != nil {
		return fmt.Errorf("query: %w", err)
	}
	defer databaseRows.Close()

	var rows []EventRow
	for databaseRows.Next() {
		var row EventRow
		if err := databaseRows.Scan(&row.ProjectID, &row.GroupID, &row.Platform, &row.ErrorMessage, &row.StackRaw); err != nil {
			return fmt.Errorf("scan: %w", err)
		}
		rows = append(rows, row)
	}
	if err := databaseRows.Err(); err != nil {
		return fmt.Errorf("rows: %w", err)
	}

	report := Predict(rows)
	requested := append([]string(nil), projects...)
	sort.Strings(requested)
	for _, project := range requested {
		projectReport, ok := report.PerProject[project]
		fmt.Printf("project %s\n", project)
		if !ok {
			fmt.Println("  zero events — nothing to preview (check the project id)")
			continue
		}

		rules := make([]string, 0, len(projectReport.SuppressedByRule))
		for rule := range projectReport.SuppressedByRule {
			rules = append(rules, rule)
		}
		sort.Strings(rules)
		for _, rule := range rules {
			fmt.Printf("  suppress %-16s %d events\n", rule, projectReport.SuppressedByRule[rule])
		}
		fmt.Printf("  family: %d events; %d old groups collapse into the ONE family group\n", projectReport.FamilyEvents, len(projectReport.FamilyCollapsed))
		for _, group := range projectReport.FamilyCollapsed {
			fmt.Printf("    joins family: %s\n", group)
		}
		fmt.Printf("  noise-only groups that disappear entirely: %d\n", len(projectReport.NoiseOnly))
		for _, group := range projectReport.NoiseOnly {
			fmt.Printf("    disappears: %s\n", group)
		}
		if len(projectReport.MixedGroups) > 0 {
			fmt.Println("  MIXED groups (cutover will NOT touch; review by hand):")
			for _, group := range projectReport.MixedGroups {
				fmt.Printf("    %s\n", group)
			}
		}
		fmt.Printf("  unchanged groups: %d\n", projectReport.UnchangedGroups)
	}
	return nil
}
