// Command link-installation links a GitHub App installation that exists on
// GitHub to an Opslane organization, for installs whose OAuth callback never
// reached Opslane. It verifies the installation with the App's own credentials
// and prints what it would change; nothing is written without -apply.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"github.com/google/uuid"

	"github.com/opslane/opslane/packages/ingestion/db"
)

const usage = "usage: link-installation -installation <id> -org <org-uuid> -expect-account <github-login> [-project <project-uuid> [-repo owner/name]] [-apply]"

type config struct {
	InstallationID int64
	OrgID          string
	ExpectAccount  string
	ProjectID      string
	Repo           string
	Apply          bool
}

func parseArgs(args []string) (config, error) {
	fs := flag.NewFlagSet("link-installation", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	installation := fs.String("installation", "", "GitHub App installation ID")
	org := fs.String("org", "", "Opslane organization UUID")
	expectAccount := fs.String("expect-account", "", "GitHub account login the installation must belong to")
	project := fs.String("project", "", "project UUID to connect to a repository (optional)")
	repo := fs.String("repo", "", "repository owner/name; required with -project when the installation covers several repositories")
	apply := fs.Bool("apply", false, "write the link; without it the command only prints what it would do")
	if err := fs.Parse(args); err != nil {
		return config{}, err
	}
	if fs.NArg() > 0 {
		return config{}, fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	installationID, err := strconv.ParseInt(*installation, 10, 64)
	if err != nil || installationID <= 0 {
		return config{}, errors.New("-installation must be a positive integer")
	}
	orgID, err := uuid.Parse(*org)
	if err != nil {
		return config{}, errors.New("-org must be an organization UUID")
	}
	if strings.TrimSpace(*expectAccount) == "" {
		return config{}, errors.New("-expect-account is required")
	}
	cfg := config{
		InstallationID: installationID,
		OrgID:          orgID.String(),
		ExpectAccount:  strings.TrimSpace(*expectAccount),
		Repo:           strings.TrimSpace(*repo),
		Apply:          *apply,
	}
	if *project != "" {
		projectID, err := uuid.Parse(*project)
		if err != nil {
			return config{}, errors.New("-project must be a project UUID")
		}
		cfg.ProjectID = projectID.String()
	}
	if cfg.Repo != "" && cfg.ProjectID == "" {
		return config{}, errors.New("-repo needs -project")
	}
	return cfg, nil
}

func main() {
	cfg, err := parseArgs(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}
	appID := os.Getenv("GITHUB_APP_ID")
	privateKey := os.Getenv("GITHUB_APP_PRIVATE_KEY")
	if os.Getenv("DATABASE_URL") == "" || appID == "" || privateKey == "" {
		fmt.Fprintln(os.Stderr, "DATABASE_URL, GITHUB_APP_ID, and GITHUB_APP_PRIVATE_KEY are required")
		os.Exit(2)
	}
	ctx := context.Background()
	pool, err := db.Connect(ctx)
	if err != nil {
		fmt.Fprintln(os.Stderr, "connect:", err)
		os.Exit(1)
	}
	runErr := run(ctx, db.New(pool), appID, []byte(privateKey), cfg, os.Stdout)
	pool.Close()
	if runErr != nil {
		fmt.Fprintln(os.Stderr, "link-installation:", runErr)
		os.Exit(1)
	}
}
