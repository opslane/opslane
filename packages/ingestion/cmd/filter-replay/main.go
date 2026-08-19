// Command filter-replay reports how the current admission rule would classify
// each issue over the last 30 days. It is intentionally read-only.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	issuefilter "github.com/opslane/opslane/packages/ingestion/filter"
)

func main() {
	if err := run(context.Background(), os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "filter-replay:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) error {
	flags := flag.NewFlagSet("filter-replay", flag.ContinueOnError)
	projectID := flags.String("project", "", "project UUID to replay")
	days := flags.Int("days", 30, "number of days to replay")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *projectID == "" {
		return errors.New("--project is required")
	}
	if *days < 1 || *days > 365 {
		return errors.New("--days must be between 1 and 365")
	}
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		return errors.New("DATABASE_URL is required")
	}
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return fmt.Errorf("parse DATABASE_URL: %w", err)
	}
	config.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
		_, err := conn.Exec(ctx, `SET default_transaction_read_only=on`)
		return err
	}
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		return fmt.Errorf("ping: %w", err)
	}

	now := time.Now().UTC()
	var latest issuefilter.DayReplay
	for day := *days - 1; day >= 0; day-- {
		at := now.AddDate(0, 0, -day)
		replay, err := issuefilter.ReplayDay(ctx, pool, *projectID, at)
		if err != nil {
			return err
		}
		fmt.Printf("%s  admit=%d  watch=%d  inactive=%d\n",
			at.Format("2006-01-02"), replay.Admit, replay.Watch, replay.Inactive)
		if day == 0 {
			latest = replay
		}
	}

	fmt.Println("\nWatched issues for the most recent day:")
	if len(latest.Watched) == 0 {
		fmt.Println("  (none)")
	}
	for _, issue := range latest.Watched {
		fmt.Printf("  %s  users=%d anon=%d  %s  %s\n",
			issue.IssueID, issue.Decision.Users7d, issue.Decision.Anon7d,
			issue.Title, issue.Decision.Reason)
	}
	return nil
}
