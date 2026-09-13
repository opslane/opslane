package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/opslane/opslane/packages/ingestion/db"
	gh "github.com/opslane/opslane/packages/ingestion/github"
)

// run verifies everything before its first write. A returned error before the
// "Writing" line means nothing was written.
func run(ctx context.Context, q *db.Queries, appID string, privateKey []byte, cfg config, out io.Writer) error {
	appJWT, err := gh.GenerateAppJWT(appID, privateKey)
	if err != nil {
		return fmt.Errorf("sign GitHub App JWT: %w", err)
	}
	app, err := gh.GetApp(appJWT)
	if err != nil {
		return fmt.Errorf("read GitHub App identity: %w", err)
	}
	if strconv.FormatInt(app.ID, 10) != appID {
		return fmt.Errorf("GitHub reports App %d for this private key, but GITHUB_APP_ID is %s", app.ID, appID)
	}
	fmt.Fprintf(out, "GitHub App:    %s (id %d)\n", app.Slug, app.ID)

	info, err := gh.VerifyInstallation(appJWT, cfg.InstallationID)
	if errors.Is(err, gh.ErrInstallationGone) {
		return fmt.Errorf("installation %d does not exist for App %s", cfg.InstallationID, app.Slug)
	}
	if err != nil {
		return fmt.Errorf("read installation %d: %w", cfg.InstallationID, err)
	}
	if !strings.EqualFold(info.Account.Login, cfg.ExpectAccount) {
		return fmt.Errorf("installation %d belongs to GitHub account %q, not %q", cfg.InstallationID, info.Account.Login, cfg.ExpectAccount)
	}
	token, err := gh.GetInstallationToken(appJWT, cfg.InstallationID)
	if errors.Is(err, gh.ErrInstallationSuspended) {
		return fmt.Errorf("installation %d is suspended on GitHub; unsuspend it first", cfg.InstallationID)
	}
	if err != nil {
		return fmt.Errorf("mint installation token: %w", err)
	}
	repos, err := gh.ListInstallationRepos(token.Token)
	if err != nil {
		return fmt.Errorf("list installation repositories: %w", err)
	}
	fmt.Fprintf(out, "Installation:  %d on GitHub account %s (%s)\n", cfg.InstallationID, info.Account.Login, info.HTMLURL)
	fmt.Fprintf(out, "Repositories:  %d\n", len(repos))
	for _, repo := range repos {
		fmt.Fprintf(out, "  - %s (default branch %s)\n", repo.FullName, repo.DefaultBranch)
	}

	orgName, orgExists, err := q.GetOrgName(ctx, cfg.OrgID)
	if err != nil {
		return err
	}
	if !orgExists {
		return fmt.Errorf("organization %s does not exist", cfg.OrgID)
	}
	fmt.Fprintf(out, "Organization:  %q (%s)\n", orgName, cfg.OrgID)

	// Legacy organization pointers are not unique, so check every organization
	// that names this installation, not only the first.
	linkedOrgs, err := q.InstallationOrgIDs(ctx, cfg.InstallationID)
	if err != nil {
		return err
	}
	alreadyLinked := false
	for _, linked := range linkedOrgs {
		if linked != cfg.OrgID {
			return fmt.Errorf("installation %d is already linked to organization %s; refusing to move it", cfg.InstallationID, linked)
		}
		alreadyLinked = true
	}
	current, err := q.GetOrgGitHubInstallation(ctx, cfg.OrgID)
	if err != nil {
		return err
	}
	if alreadyLinked {
		fmt.Fprintln(out, "Status:        already linked to this organization; -apply refreshes its repositories")
	} else {
		fmt.Fprintln(out, "Status:        not linked")
	}
	// PersistInstallation always points the organization at this installation,
	// so warn whenever that moves an existing pointer, linked or not.
	if current != 0 && current != cfg.InstallationID {
		fmt.Fprintf(out, "Warning:       the organization's primary installation changes from %d to %d\n", current, cfg.InstallationID)
	}

	var target *gh.Repo
	if cfg.ProjectID != "" {
		project, err := q.GetProjectByOrgID(ctx, cfg.OrgID, cfg.ProjectID)
		if err != nil {
			return err
		}
		if project == nil {
			return fmt.Errorf("project %s is not in organization %s", cfg.ProjectID, cfg.OrgID)
		}
		if target, err = chooseRepo(repos, cfg.Repo); err != nil {
			return err
		}
		if project.GithubRepo != nil && *project.GithubRepo != "" {
			if !strings.EqualFold(*project.GithubRepo, target.FullName) {
				return fmt.Errorf("project %q is already connected to %s; disconnect it in Settings first", project.Name, *project.GithubRepo)
			}
			// Keep the stored spelling: a case-only change looks like a new
			// repository to SetProjectGitHubConfig and queues a context rebuild.
			stored := *target
			stored.FullName = *project.GithubRepo
			target = &stored
		}
		fmt.Fprintf(out, "Project:       %q (%s) connects to %s\n", project.Name, project.ID, target.FullName)
	} else {
		projects, err := q.ListProjectsByOrg(ctx, cfg.OrgID)
		if err != nil {
			return err
		}
		fmt.Fprintln(out, "Projects (pass -project to connect one):")
		for _, p := range projects {
			repo := "no repository"
			if p.GithubRepo != nil && *p.GithubRepo != "" {
				repo = *p.GithubRepo
			}
			fmt.Fprintf(out, "  - %s %q (%s)\n", p.ID, p.Name, repo)
		}
	}

	if !cfg.Apply {
		fmt.Fprintln(out, "\nDry run: nothing written. Re-run with -apply to link.")
		return nil
	}

	fmt.Fprintln(out, "\nWriting.")
	installRepos := make([]db.InstallationRepo, 0, len(repos))
	for _, repo := range repos {
		installRepos = append(installRepos, db.InstallationRepo{FullName: repo.FullName, DefaultBranch: repo.DefaultBranch})
	}
	tx, err := q.Pool().Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := q.PersistInstallation(ctx, tx, db.PersistInstallationParams{
		InstallationID: cfg.InstallationID,
		GitHubOrgName:  info.Account.Login,
		GitHubOrgID:    info.Account.ID,
		OrgID:          cfg.OrgID,
		Repos:          installRepos,
		HTMLURL:        info.HTMLURL,
	}); err != nil {
		if errors.Is(err, db.ErrInstallationOrgConflict) {
			return fmt.Errorf("installation %d was linked to another organization while this ran; nothing written", cfg.InstallationID)
		}
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit installation: %w", err)
	}
	fmt.Fprintf(out, "Linked installation %d to %s.\n", cfg.InstallationID, orgName)

	if target != nil {
		if err := q.SetProjectGitHubConfig(ctx, cfg.OrgID, cfg.ProjectID, target.FullName, target.DefaultBranch); err != nil {
			return fmt.Errorf("installation is linked, but connecting the project failed (re-run with -apply): %w", err)
		}
		fmt.Fprintf(out, "Connected project %s to %s.\n", cfg.ProjectID, target.FullName)
	}

	// Read back this installation specifically, not just "some installation".
	linkedOrgs, err = q.InstallationOrgIDs(ctx, cfg.InstallationID)
	if err != nil {
		return err
	}
	pointer, err := q.GetOrgGitHubInstallation(ctx, cfg.OrgID)
	if err != nil {
		return err
	}
	active, err := q.OrgHasActiveGitHubInstallation(ctx, cfg.OrgID)
	if err != nil {
		return err
	}
	if len(linkedOrgs) != 1 || linkedOrgs[0] != cfg.OrgID || pointer != cfg.InstallationID || !active {
		return fmt.Errorf("link committed, but read-back failed: installation organizations %v, organization installation %d, active %v", linkedOrgs, pointer, active)
	}
	if target != nil {
		covered, err := q.RepoCoveredByActiveInstallation(ctx, cfg.OrgID, target.FullName)
		if err != nil {
			return err
		}
		if !covered {
			return fmt.Errorf("link committed, but read-back failed: %s is not covered by an active installation", target.FullName)
		}
	}
	fmt.Fprintln(out, "Verified: the dashboard now reports GitHub as installed.")
	return nil
}

// chooseRepo returns the repository to connect, using GitHub's spelling.
func chooseRepo(repos []gh.Repo, want string) (*gh.Repo, error) {
	if want != "" {
		for i := range repos {
			if strings.EqualFold(repos[i].FullName, want) {
				return &repos[i], nil
			}
		}
		return nil, fmt.Errorf("installation does not cover %s; it covers: %s", want, repoNames(repos))
	}
	switch len(repos) {
	case 0:
		return nil, errors.New("installation covers no repositories; add one on GitHub first")
	case 1:
		return &repos[0], nil
	default:
		return nil, fmt.Errorf("installation covers %d repositories; pass -repo with one of: %s", len(repos), repoNames(repos))
	}
}

func repoNames(repos []gh.Repo) string {
	if len(repos) == 0 {
		return "(none)"
	}
	names := make([]string, 0, len(repos))
	for _, repo := range repos {
		names = append(names, repo.FullName)
	}
	return strings.Join(names, ", ")
}
