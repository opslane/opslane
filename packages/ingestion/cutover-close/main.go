// Command cutover-close closes old-scheme groups superseded by the slice-1
// grouping ladder. It is a dry run unless --apply is supplied, and applied runs
// require a new audit JSONL file containing pre-images plus a commit manifest.
package main

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/opslane/opslane/packages/ingestion/grouping"
)

var closeableStatuses = map[string]bool{"investigated": true, "needs_human": true}

type eventForClose struct {
	Platform string
	Message  string
	Stack    string
}

// eventRemovable reports whether one event classifies as family or suppressed
// noise using its own platform.
func eventRemovable(event eventForClose) bool {
	if _, drop := grouping.Suppress(event.Platform, event.Message, event.Stack); drop {
		return true
	}
	_, matched := grouping.FamilyFingerprint(event.Platform, event.Message)
	return matched
}

func readIDs(path string) (map[string]bool, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	ids := make(map[string]bool)
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		if id := strings.TrimSpace(scanner.Text()); id != "" {
			ids[id] = true
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}
	if len(ids) == 0 {
		return nil, fmt.Errorf("%s contains no ids — refusing an accidental no-op", path)
	}
	return ids, nil
}

type rowQueryer interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

// groupRemovable reports whether every event in the group classifies as family or
// suppressed noise. Empty groups are not removable.
//
// It streams and short-circuits rather than collecting the group's events: the
// groups this tool targets are the highest-volume noise groups in the project
// (that is why they are suppression candidates), so materializing them would put
// an unbounded slice on the operator's machine and risk blowing the 120s
// statement timeout on exactly the groups that matter most.
func groupRemovable(ctx context.Context, queryer rowQueryer, groupID, projectID string) (bool, error) {
	rows, err := queryer.Query(ctx, `
		SELECT platform, error_message, stack_trace_raw
		FROM error_events
		WHERE error_group_id = $1 AND project_id = $2`, groupID, projectID)
	if err != nil {
		return false, err
	}
	defer rows.Close()

	sawEvent := false
	for rows.Next() {
		var event eventForClose
		if err := rows.Scan(&event.Platform, &event.Message, &event.Stack); err != nil {
			return false, err
		}
		sawEvent = true
		if !eventRemovable(event) {
			// One ordinary event disqualifies the group; stop reading.
			return false, nil
		}
	}
	if err := rows.Err(); err != nil {
		return false, err
	}
	return sawEvent, nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "cutover-close: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	projectID := flag.String("project", "", "project UUID (required)")
	apply := flag.Bool("apply", false, "actually close groups (default: dry run)")
	auditPath := flag.String("audit", "", "JSONL audit file (required with --apply)")
	idsPath := flag.String("ids", "", "restrict to these group IDs (pass-2 mode)")
	skippedPath := flag.String("skipped", "", "write removable-but-wrong-status ids here, sorted")
	flag.Parse()

	if *projectID == "" {
		return fmt.Errorf("--project is required")
	}
	if *apply && *auditPath == "" {
		return fmt.Errorf("--apply requires --audit")
	}
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		return fmt.Errorf("DATABASE_URL is required")
	}
	var restrictIDs map[string]bool
	if *idsPath != "" {
		var err error
		restrictIDs, err = readIDs(*idsPath)
		if err != nil {
			return err
		}
	}

	ctx := context.Background()
	conn, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, "SET statement_timeout = '120s'"); err != nil {
		return fmt.Errorf("session setup: %w", err)
	}

	type groupMeta struct {
		id     string
		status string
		title  string
		hasPR  bool
	}
	groupRows, err := conn.Query(ctx, `
		SELECT g.id::text, g.status::text, g.title, g.pr_url IS NOT NULL
		FROM error_groups g
		WHERE g.project_id = $1 AND g.fingerprint NOT LIKE 'js|v2|%'
		ORDER BY g.id`, *projectID)
	if err != nil {
		return fmt.Errorf("groups query: %w", err)
	}
	var groups []groupMeta
	for groupRows.Next() {
		var group groupMeta
		if err := groupRows.Scan(&group.id, &group.status, &group.title, &group.hasPR); err != nil {
			groupRows.Close()
			return fmt.Errorf("scan: %w", err)
		}
		if restrictIDs == nil || restrictIDs[group.id] {
			groups = append(groups, group)
		}
	}
	if err := groupRows.Err(); err != nil {
		groupRows.Close()
		return fmt.Errorf("rows: %w", err)
	}
	groupRows.Close()

	var toClose, wrongStatus []groupMeta
	for _, group := range groups {
		removable, err := groupRemovable(ctx, conn, group.id, *projectID)
		if err != nil {
			return fmt.Errorf("events %s: %w", group.id, err)
		}
		if !removable {
			continue
		}
		if closeableStatuses[group.status] {
			toClose = append(toClose, group)
		} else {
			wrongStatus = append(wrongStatus, group)
		}
	}
	sort.Slice(wrongStatus, func(left, right int) bool {
		if wrongStatus[left].status != wrongStatus[right].status {
			return wrongStatus[left].status < wrongStatus[right].status
		}
		return wrongStatus[left].id < wrongStatus[right].id
	})

	fmt.Printf("would close %d groups:\n", len(toClose))
	for _, group := range toClose {
		marker := ""
		if group.hasPR {
			marker = "  [HAS PR — eyeball this one]"
		}
		fmt.Printf("  %s  %-12s  %s%s\n", group.id, group.status, group.title, marker)
	}
	fmt.Println("removable but wrong status (left open; ids -> --skipped file):")
	for _, group := range wrongStatus {
		fmt.Printf("  %s  %-12s  %s\n", group.id, group.status, group.title)
	}
	if *skippedPath != "" {
		var contents strings.Builder
		for _, group := range wrongStatus {
			contents.WriteString(group.id + "\n")
		}
		if err := os.WriteFile(*skippedPath, []byte(contents.String()), 0o600); err != nil {
			return fmt.Errorf("write skipped file: %w", err)
		}
		fmt.Printf("wrote %d skipped ids to %s\n", len(wrongStatus), *skippedPath)
	}

	if !*apply {
		fmt.Println("dry run — nothing written. Re-run with --apply --audit <path> to close.")
		return nil
	}
	if len(toClose) == 0 {
		fmt.Println("nothing to close.")
		return nil
	}

	audit, err := os.OpenFile(*auditPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("audit file: %w (refusing to overwrite an existing audit)", err)
	}
	defer audit.Close()
	if _, err := fmt.Fprintf(audit, `{"meta":{"project":%q,"started_at":%q,"candidates":%d}}`+"\n",
		*projectID, time.Now().UTC().Format(time.RFC3339), len(toClose)); err != nil {
		return fmt.Errorf("audit metadata: %w", err)
	}

	tx, err := conn.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer tx.Rollback(ctx)

	closed, raced := 0, 0
	for _, group := range toClose {
		var status, preImage string
		if err := tx.QueryRow(ctx, `
			SELECT status::text, row_to_json(g)::text
			FROM error_groups g
			WHERE id = $1 AND project_id = $2
			FOR UPDATE`, group.id, *projectID).Scan(&status, &preImage); err != nil {
			return fmt.Errorf("lock %s: %w", group.id, err)
		}
		if !closeableStatuses[status] {
			fmt.Printf("  raced: %s moved to %s since preview — skipped\n", group.id, status)
			raced++
			continue
		}
		stillRemovable, err := groupRemovable(ctx, tx, group.id, *projectID)
		if err != nil {
			return fmt.Errorf("reclassify %s: %w", group.id, err)
		}
		if !stillRemovable {
			fmt.Printf("  raced: %s gained ordinary events since preview — skipped\n", group.id)
			raced++
			continue
		}
		if _, err := fmt.Fprintln(audit, preImage); err != nil {
			return fmt.Errorf("audit write: %w — nothing committed", err)
		}
		if _, err := tx.Exec(ctx, `
			UPDATE error_groups
			SET status = 'resolved', resolved_reason = 'superseded_by_regrouping',
			    resolved_at = now(), updated_at = now()
			WHERE id = $1 AND project_id = $2`, group.id, *projectID); err != nil {
			return fmt.Errorf("update %s: %w — nothing committed", group.id, err)
		}
		closed++
	}
	if err := audit.Sync(); err != nil {
		return fmt.Errorf("audit sync: %w — nothing committed", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w — audit pre-images are candidates only (no manifest line)", err)
	}
	if _, err := fmt.Fprintf(audit, `{"committed":%d}`+"\n", closed); err != nil {
		fmt.Fprintf(os.Stderr, "warning: manifest write failed: %v (transaction IS committed)\n", err)
	} else if err := audit.Sync(); err != nil {
		fmt.Fprintf(os.Stderr, "warning: manifest sync failed: %v (transaction IS committed)\n", err)
	}
	fmt.Printf("closed %d groups, %d raced-and-skipped (audit: %s)\n", closed, raced, *auditPath)
	return nil
}
