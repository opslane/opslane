package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opslane/opslane/packages/ingestion/auth"
)

// ErrTokenReuse is returned when a previously consumed refresh token is presented again,
// indicating a potential token theft. All tokens in the family are revoked.
var ErrTokenReuse = errors.New("refresh token reuse detected")

// ErrNotInvestigated is returned when TriggerFixJob is called on an incident
// that is not in the fix-triggerable state for its kind.
var ErrNotInvestigated = errors.New("incident not in a fix-triggerable state")

// ErrNoGithubRepo indicates the project has no repo configured for a setup PR.
var ErrNoGithubRepo = errors.New("project has no github_repo")

// ErrOrgOnboarded rejects onboarding setup for an org whose wizard already completed.
var ErrOrgOnboarded = errors.New("org already onboarded")

// ErrIdentityConflict indicates that a provider subject is already owned by a
// different local user. Callers must fail closed rather than issue a session.
var ErrIdentityConflict = errors.New("auth identity belongs to a different user")

// ErrOAuthLoginStateInFlight means another callback currently owns the state
// lease. The caller may retry after the two-minute reservation window.
var ErrOAuthLoginStateInFlight = errors.New("OAuth login state is already in flight")

// ErrOAuthLoginStateReservation means the reservation token is stale, expired,
// or does not own the state.
var ErrOAuthLoginStateReservation = errors.New("OAuth login state reservation is no longer valid")

// ErrInvalidInvitation is returned for missing, expired, revoked, consumed, or
// email-mismatched invitations. It intentionally does not reveal which check failed.
var ErrInvalidInvitation = errors.New("invalid invitation")

var (
	ErrPRAlreadyLinked  = errors.New("incident already has a pull request")
	ErrPRRepoMismatch   = errors.New("pull request is not in this project's repository")
	ErrIncidentNotFound = errors.New("incident not found")
)

// Queries wraps a connection pool and provides tenant-scoped database operations.
// All query helpers MUST take tenant scope (project_id or org_id) as required parameter.
type Queries struct {
	pool *pgxpool.Pool
	// DashboardURL is the reader-facing dashboard base used in notification
	// links. Empty or invalid values omit the link.
	DashboardURL string
}

func New(pool *pgxpool.Pool) *Queries {
	return &Queries{pool: pool}
}

// Pool exposes the underlying pool for health checks and migration runner only.
func (q *Queries) Pool() *pgxpool.Pool {
	return q.pool
}

func nilIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// LatestDeliveredDigest returns the run date and generated cards from the most
// recent delivered digest, or ("", nil, nil) when none exists. Validation stamps
// generated_cards with system facts before delivery, so they are returned as-is.
func (q *Queries) LatestDeliveredDigest(ctx context.Context, projectID string) (runDate string, cards []byte, err error) {
	err = q.pool.QueryRow(ctx,
		`SELECT run_date::text,
		        coalesce(rendered_payload->'digest'->'generated_cards', '[]'::jsonb)
		   FROM digest_runs
		  WHERE project_id = $1
		    AND status = 'delivered'
		    AND rendered_payload IS NOT NULL
		  ORDER BY run_date DESC
		  LIMIT 1`, projectID,
	).Scan(&runDate, &cards)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil, nil
	}
	return runDate, cards, err
}

type EvidenceFrame struct {
	AnchorKind      string          `json:"anchor_kind"`
	SourceEventID   string          `json:"source_event_id"`
	Status          string          `json:"status"`
	ResolverVersion *int            `json:"resolver_version"`
	Envelope        json.RawMessage `json:"envelope"`
	CommitSHA       *string         `json:"commit_sha"`
}

type EvidenceFailedRequest struct {
	SessionID       string  `json:"session_id"`
	PageRoute       string  `json:"page_route"`
	Method          string  `json:"method"`
	EndpointPattern string  `json:"endpoint_pattern"`
	Status          int     `json:"status"`
	ActionKind      *string `json:"action_kind"`
	ActionSelector  *string `json:"action_selector"`
	ActionLink      string  `json:"action_link"`
	OccurredAt      string  `json:"occurred_at"`
}

type EvidenceReplayPointer struct {
	AnchorKind string `json:"anchor_kind"`
	EventID    string `json:"event_id"`
	SessionID  string `json:"session_id"`
	AnchorMs   int64  `json:"anchor_ms"`
}

type IssueEvidenceResult struct {
	Frames         []EvidenceFrame
	FailedRequests []EvidenceFailedRequest
	ReplayPointers []EvidenceReplayPointer
	Recording      string
	SourceMap      string
}

// IssueEvidence assembles the fix-shaped evidence for a group's open episode.
// It mirrors the worker's loadEvidence read path, but an issue without frozen
// anchors returns an empty result instead of an error.
func (q *Queries) IssueEvidence(ctx context.Context, projectID, groupID string) (IssueEvidenceResult, error) {
	res := IssueEvidenceResult{Recording: "missing", SourceMap: "missing"}

	var episodeID string
	err := q.pool.QueryRow(ctx,
		`SELECT id
		   FROM issue_episodes
		  WHERE project_id = $1
		    AND canonical_issue_id = $2
		    AND closed_at IS NULL
		  ORDER BY sequence DESC
		  LIMIT 1`, projectID, groupID,
	).Scan(&episodeID)
	if errors.Is(err, pgx.ErrNoRows) {
		return res, nil
	}
	if err != nil {
		return res, fmt.Errorf("resolve episode: %w", err)
	}

	rows, err := q.pool.Query(ctx,
		`SELECT a.anchor_kind, a.event_id, e.session_id, e.commit_sha,
		        r.status, r.envelope, r.resolver_version,
		        (extract(epoch FROM e."timestamp") * 1000)::bigint AS anchor_ms,
		        CASE WHEN s.status <> 'deleting' THEN s.id END AS retained_session_id
		   FROM issue_evidence_anchors a
		   JOIN error_events e
		     ON e.id = a.event_id AND e.project_id = a.project_id
		   LEFT JOIN sessions s
		     ON s.id = e.session_id AND s.project_id = a.project_id
		   LEFT JOIN error_event_resolutions r
		     ON r.event_id = a.event_id AND r.project_id = a.project_id
		  WHERE a.project_id = $1 AND a.episode_id = $2
		  ORDER BY CASE a.anchor_kind WHEN 'threshold' THEN 0 WHEN 'first' THEN 1 ELSE 2 END`,
		projectID, episodeID)
	if err != nil {
		return res, fmt.Errorf("anchors: %w", err)
	}
	defer rows.Close()

	var retained []string
	seenRetained := map[string]bool{}
	for rows.Next() {
		var frame EvidenceFrame
		var sessionID *string
		var anchorMs int64
		var retainedID *string
		var status sql.NullString
		if err := rows.Scan(&frame.AnchorKind, &frame.SourceEventID, &sessionID, &frame.CommitSHA,
			&status, &frame.Envelope, &frame.ResolverVersion, &anchorMs, &retainedID); err != nil {
			return res, fmt.Errorf("scan anchor: %w", err)
		}
		frame.Status = "missing"
		if status.Valid && status.String != "" {
			frame.Status = status.String
		}
		res.Frames = append(res.Frames, frame)
		if frame.AnchorKind == "threshold" {
			res.SourceMap = frame.Status
		}
		if sessionID != nil {
			res.ReplayPointers = append(res.ReplayPointers, EvidenceReplayPointer{
				AnchorKind: frame.AnchorKind,
				EventID:    frame.SourceEventID,
				SessionID:  *sessionID,
				AnchorMs:   anchorMs,
			})
		}
		if retainedID != nil && !seenRetained[*retainedID] {
			seenRetained[*retainedID] = true
			retained = append(retained, *retainedID)
		}
	}
	if err := rows.Err(); err != nil {
		return res, fmt.Errorf("iterate anchors: %w", err)
	}
	if len(res.Frames) == 0 {
		return res, nil
	}
	res.Recording = recordingAvailabilityFromRetained(retained, res.ReplayPointers)

	if len(retained) == 0 {
		return res, nil
	}
	failureRows, err := q.pool.Query(ctx,
		`SELECT f.session_id, f.page_route, f.method, f.endpoint_pattern, f.status,
		        f.action_kind, f.action_selector, f.action_link, f.occurred_at::text
		   FROM session_request_failures f
		  WHERE f.project_id = $1
		    AND f.session_id = ANY($2::text[])
		    AND f.rule_version = (
		      SELECT analysis.rule_version
		        FROM session_analysis analysis
		       WHERE analysis.project_id = f.project_id
		         AND analysis.session_id = f.session_id
		    )
		  ORDER BY f.occurred_at DESC, f.request_id_hash
		  LIMIT 50`, projectID, retained)
	if err != nil {
		return res, fmt.Errorf("failed requests: %w", err)
	}
	defer failureRows.Close()
	for failureRows.Next() {
		var failure EvidenceFailedRequest
		if err := failureRows.Scan(&failure.SessionID, &failure.PageRoute, &failure.Method,
			&failure.EndpointPattern, &failure.Status, &failure.ActionKind,
			&failure.ActionSelector, &failure.ActionLink, &failure.OccurredAt); err != nil {
			return res, fmt.Errorf("scan failed request: %w", err)
		}
		res.FailedRequests = append(res.FailedRequests, failure)
	}
	if err := failureRows.Err(); err != nil {
		return res, fmt.Errorf("iterate failed requests: %w", err)
	}
	return res, nil
}

// recordingAvailabilityFromRetained mirrors the worker's four-state recording
// availability calculation.
func recordingAvailabilityFromRetained(retained []string, pointers []EvidenceReplayPointer) string {
	referenced := map[string]bool{}
	for _, pointer := range pointers {
		referenced[pointer.SessionID] = true
	}
	if len(referenced) == 0 {
		return "missing"
	}
	if len(retained) == 0 {
		return "expired"
	}
	if len(retained) < len(referenced) {
		return "partial"
	}
	return "available"
}

// LinkPR records a developer's PR on error_groups so the existing merge webhook
// can resolve it. Repository matching and the no-overwrite guard are enforced
// in the update predicate.
func (q *Queries) LinkPR(ctx context.Context, projectID, groupID, prURL, repo string, prNumber int) error {
	tag, err := q.pool.Exec(ctx,
		`UPDATE error_groups eg
		    SET pr_url = $3,
		        pr_number = $4,
		        status = 'pr_created',
		        pr_created_at = COALESCE(eg.pr_created_at, now()),
		        updated_at = now()
		   FROM projects p
		  WHERE eg.id = $1
		    AND eg.project_id = $2
		    AND p.id = eg.project_id
		    AND eg.pr_number IS NULL
		    AND eg.status NOT IN ('resolved', 'archived', 'merged')
		    AND p.github_repo IS NOT NULL
		    AND lower(p.github_repo) = lower($5)`,
		groupID, projectID, prURL, prNumber, repo)
	if err != nil {
		return fmt.Errorf("link pr: %w", err)
	}
	if tag.RowsAffected() == 1 {
		return nil
	}

	// The update matched no row: the incident is absent for this project, its
	// repo differs, or it already has a PR / is in a terminal state. Scope the
	// lookup by project_id like the update, so a foreign incident id is a 404
	// rather than leaking its existence. A repo mismatch is the only refusal we
	// can name distinctly; every other case is the "already linked" 409.
	var repoMatches bool
	if err := q.pool.QueryRow(ctx,
		`SELECT lower(coalesce(p.github_repo, '')) = lower($3)
		   FROM error_groups eg
		   JOIN projects p ON p.id = eg.project_id
		  WHERE eg.id = $1 AND eg.project_id = $2`,
		groupID, projectID, repo).Scan(&repoMatches); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrIncidentNotFound
		}
		return fmt.Errorf("classify link pr refusal: %w", err)
	}
	if !repoMatches {
		return ErrPRRepoMismatch
	}
	return ErrPRAlreadyLinked
}

// investigationReadinessSQL keeps the legacy API field derived from the
// append-only pipeline decisions while callers migrate to the explicit states.
func investigationReadinessSQL(groupAlias string) string {
	return fmt.Sprintf(`(
		SELECT CASE
		         WHEN factual.decision='open_inquiry' AND inquiry.decision='investigate' THEN 'eligible'
		         WHEN factual.decision='open_inquiry' AND inquiry.decision IS NULL THEN 'pending'
		         WHEN factual.decision IS NOT NULL THEN 'ineligible'
		       END
		  FROM issue_episodes ep
		  LEFT JOIN LATERAL (
		    SELECT d.decision FROM issue_decisions d
		     WHERE d.project_id=ep.project_id AND d.episode_id=ep.id
		     ORDER BY d.decided_at DESC,d.id DESC LIMIT 1
		  ) factual ON true
		  LEFT JOIN LATERAL (
		    SELECT d.decision FROM issue_inquiry_decisions d
		     WHERE d.project_id=ep.project_id AND d.episode_id=ep.id
		     ORDER BY d.decided_at DESC,d.id DESC LIMIT 1
		  ) inquiry ON true
		 WHERE ep.project_id=%[1]s.project_id AND ep.canonical_issue_id=%[1]s.id
		 ORDER BY ep.sequence DESC LIMIT 1
	)`, groupAlias)
}

// NormalizeEmail is the storage and lookup contract for user and invitation email.
func NormalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

// === Tenant hierarchy ===

type Org struct {
	ID        string
	Name      string
	CreatedAt time.Time
}

type Project struct {
	ID                   string
	OrgID                string
	Name                 string
	GithubRepo           *string
	DefaultBranch        *string // NULL until learned from GitHub or a clone
	FrictionAutonomy     string
	PrPosture            string
	DefaultEnvironmentID *string
	DigestTimezone       string
	CreatedAt            time.Time
}

type Environment struct {
	ID        string
	ProjectID string
	Name      string
	CreatedAt time.Time
}

type ProjectProvisioning struct {
	Project     Project
	Environment Environment
	APIKey      MintedProjectKey
}

// OrgExists checks whether an org with the given ID exists.
func (q *Queries) OrgExists(ctx context.Context, orgID string) (bool, error) {
	var exists bool
	err := q.pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM orgs WHERE id = $1)`, orgID,
	).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("check org exists: %w", err)
	}
	return exists, nil
}

func (q *Queries) CreateOrg(ctx context.Context, name string) (*Org, error) {
	var org Org
	err := q.pool.QueryRow(ctx,
		`INSERT INTO orgs (name) VALUES ($1) RETURNING id, name, created_at`,
		name,
	).Scan(&org.ID, &org.Name, &org.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("create org: %w", err)
	}
	return &org, nil
}

func (q *Queries) CreateProject(ctx context.Context, orgID, name string, githubRepo *string) (*Project, error) {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("create project: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	p, err := q.CreateProjectTx(ctx, tx, orgID, name, githubRepo)
	if err != nil {
		return nil, err
	}
	env, err := q.EnsureProjectDefaultEnvironmentTx(ctx, tx, p.ID)
	if err != nil {
		return nil, fmt.Errorf("create project: %w", err)
	}
	p.DefaultEnvironmentID = &env.ID
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("create project: commit: %w", err)
	}
	return p, nil
}

// ProvisionProject atomically creates the first-class project bundle. Reusing
// an idempotency token preserves the original project/environment and returns
// a freshly minted replacement without revoking previously deployed keys.
func (q *Queries) ProvisionProject(
	ctx context.Context,
	orgID, name string,
	githubRepo *string,
	idempotencyToken string,
) (*ProjectProvisioning, error) {
	if strings.TrimSpace(idempotencyToken) == "" {
		return nil, fmt.Errorf("provision project: idempotency token is required")
	}
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("provision project: begin: %w", err)
	}
	defer tx.Rollback(ctx)

	result, err := q.provisionProjectTx(ctx, tx, orgID, name, githubRepo, idempotencyToken)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("provision project: commit: %w", err)
	}
	return result, nil
}

// OnboardingProvision is the wizard's project bootstrap. It serializes setup
// per org so concurrent retries cannot create duplicate first projects.
func (q *Queries) OnboardingProvision(
	ctx context.Context,
	orgID, name string,
	githubRepo *string,
	idempotencyToken string,
) (*ProjectProvisioning, error) {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("onboarding provision: begin: %w", err)
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('onboard-' || $1))`, orgID); err != nil {
		return nil, fmt.Errorf("onboarding provision: lock: %w", err)
	}

	var onboardedAt *time.Time
	if err := tx.QueryRow(ctx, `SELECT onboarded_at FROM orgs WHERE id = $1`, orgID).Scan(&onboardedAt); err != nil {
		return nil, fmt.Errorf("onboarding provision: org lookup: %w", err)
	}
	if onboardedAt != nil {
		return nil, ErrOrgOnboarded
	}

	var result *ProjectProvisioning
	var existing Project
	err = tx.QueryRow(ctx, `
		SELECT id, org_id, name, github_repo, default_branch, friction_autonomy,
		       pr_posture, default_environment_id, digest_timezone, created_at
		FROM projects
		WHERE org_id = $1
		ORDER BY created_at DESC, id DESC
		LIMIT 1`, orgID,
	).Scan(
		&existing.ID, &existing.OrgID, &existing.Name, &existing.GithubRepo,
		&existing.DefaultBranch, &existing.FrictionAutonomy, &existing.PrPosture,
		&existing.DefaultEnvironmentID, &existing.DigestTimezone, &existing.CreatedAt,
	)
	switch {
	case err == nil:
		environment, envErr := q.EnsureProjectDefaultEnvironmentTx(ctx, tx, existing.ID)
		if envErr != nil {
			return nil, fmt.Errorf("onboarding provision: %w", envErr)
		}
		key, keyErr := q.CreateProjectKeyTx(ctx, tx, existing.ID, ScopeIngest, "onboarding", nil, "")
		if keyErr != nil {
			return nil, fmt.Errorf("onboarding provision: %w", keyErr)
		}
		if existing.DefaultEnvironmentID == nil {
			existing.DefaultEnvironmentID = &environment.ID
		}
		result = &ProjectProvisioning{Project: existing, Environment: *environment, APIKey: *key}
	case errors.Is(err, pgx.ErrNoRows):
		result, err = q.provisionProjectTx(ctx, tx, orgID, name, githubRepo, idempotencyToken)
		if err != nil {
			return nil, err
		}
	default:
		return nil, fmt.Errorf("onboarding provision: project lookup: %w", err)
	}

	if err := RevokeExcessOnboardingKeysTx(ctx, tx, result.Project.ID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("onboarding provision: commit: %w", err)
	}
	return result, nil
}

// provisionProjectTx performs the project/environment/key mutation inside a
// caller-owned transaction. Keeping this transaction body shared lets related
// provisioning state changes commit under the same project row lock.
func (q *Queries) provisionProjectTx(
	ctx context.Context,
	tx pgx.Tx,
	orgID, name string,
	githubRepo *string,
	idempotencyToken string,
) (*ProjectProvisioning, error) {
	if strings.TrimSpace(idempotencyToken) == "" {
		return nil, fmt.Errorf("provision project: idempotency token is required")
	}

	var result ProjectProvisioning
	var inserted bool
	err := tx.QueryRow(ctx, `
		INSERT INTO projects (org_id, name, github_repo, idempotency_token)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (org_id, idempotency_token) WHERE idempotency_token IS NOT NULL
		DO UPDATE SET idempotency_token = EXCLUDED.idempotency_token
		RETURNING id, org_id, name, github_repo, default_branch,
		          friction_autonomy, pr_posture, default_environment_id, digest_timezone, created_at,
		          (xmax = 0) AS inserted`,
		orgID, name, githubRepo, idempotencyToken,
	).Scan(
		&result.Project.ID,
		&result.Project.OrgID,
		&result.Project.Name,
		&result.Project.GithubRepo,
		&result.Project.DefaultBranch,
		&result.Project.FrictionAutonomy,
		&result.Project.PrPosture,
		&result.Project.DefaultEnvironmentID,
		&result.Project.DigestTimezone,
		&result.Project.CreatedAt,
		&inserted,
	)
	if err != nil {
		return nil, fmt.Errorf("provision project: upsert project: %w", err)
	}

	// Gaining a repo at first provisioning is a connect transition (D4).
	// Idempotent replays hit the conflict arm and must not re-enqueue.
	if inserted && githubRepo != nil && strings.TrimSpace(*githubRepo) != "" {
		if err := enqueueProductContextConnectTx(ctx, tx, result.Project.ID); err != nil {
			return nil, fmt.Errorf("provision project: %w", err)
		}
	}

	env, err := q.EnsureProjectDefaultEnvironmentTx(ctx, tx, result.Project.ID)
	if err != nil {
		return nil, fmt.Errorf("provision project: %w", err)
	}
	result.Environment = *env
	if result.Project.DefaultEnvironmentID == nil {
		result.Project.DefaultEnvironmentID = &env.ID
	}

	apiKey, err := q.CreateProjectKeyTx(
		ctx, tx, result.Project.ID, ScopeIngest, "onboarding", nil, "",
	)
	if err != nil {
		return nil, fmt.Errorf("provision project: %w", err)
	}
	result.APIKey = *apiKey

	return &result, nil
}

// GetProjectIdentity returns a project's name and repo for operator-facing
// confirmation output (mint-key prints it before exposing a key). Scoped by
// primary key; read-only.
func (q *Queries) GetProjectIdentity(ctx context.Context, projectID string) (string, *string, error) {
	var name string
	var githubRepo *string
	err := q.pool.QueryRow(ctx,
		`SELECT name, github_repo FROM projects WHERE id = $1`, projectID,
	).Scan(&name, &githubRepo)
	if err != nil {
		return "", nil, fmt.Errorf("get project identity: %w", err)
	}
	return name, githubRepo, nil
}

// CreateEnvironment is a test-fixture compatibility helper. Production
// environment creation flows through telemetry transactions.
func (q *Queries) CreateEnvironment(ctx context.Context, projectID, name string) (*Environment, error) {
	var env Environment
	err := q.pool.QueryRow(ctx,
		`INSERT INTO environments (project_id, name)
		 VALUES ($1, $2)
		 ON CONFLICT (project_id, name) DO UPDATE SET name = EXCLUDED.name
		 RETURNING id, project_id, name, created_at`,
		projectID, name,
	).Scan(&env.ID, &env.ProjectID, &env.Name, &env.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("create environment: %w", err)
	}
	return &env, nil
}

// FindEnvironmentIDByName resolves an environment name inside one project.
// An empty id means no match; environment ids are never accepted from clients.
func (q *Queries) FindEnvironmentIDByName(ctx context.Context, projectID, name string) (string, error) {
	var id string
	err := q.pool.QueryRow(ctx,
		`SELECT id FROM environments WHERE project_id = $1 AND name = $2`,
		projectID, name,
	).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("resolve environment name: %w", err)
	}
	return id, nil
}

// nonRetriableReasonCodes lists needs_human reason codes that represent permanent
// failures and should NOT trigger re-queuing on recurrence.
var nonRetriableReasonCodes = map[string]struct{}{
	"policy_blocked": {},
	"auth_invalid":   {},
	// Stackless / no-app-frame errors (cross-origin "Script error.", non-Error
	// promise rejections) are inherently unfixable. Don't auto-reopen the single
	// collapsed group on every recurrence.
	"unfixable_no_app_frames": {},
	"triage_unfixable":        {},
	// Gate failures: the agent tried and could not confidently fix. Keep the
	// writeup terminal on recurrence rather than wiping it and re-investigating.
	"low_confidence_fix": {},
	"tests_failed":       {},
	// The agent produced a writeup but a reproduction could not be constructed.
	// Keep the writeup terminal on recurrence, like low_confidence_fix.
	"repro_not_achievable": {},
	// verification_infra_error is intentionally absent: infrastructure failures
	// are transient, so recurrence should requeue and retry verification.
	// These errors cannot be fixed in application code. They remain terminal even
	// if inactivity resolution changes the group's status from needs_human.
	"unfixable_infra":       {},
	"unfixable_third_party": {},
	"unfixable_test_error":  {},
	// unfixable_no_sourcemap is intentionally absent: uploading source maps can
	// make a later investigation actionable.
}

const (
	// Ordinary candidates are hidden workflow records (issue #56); the only
	// visible candidate is an exhausted 'unchecked' adjudication diagnostic.
	visibleCandidateSQL = "(eg.status <> 'candidate' OR eg.adjudication_status = 'unchecked')"

	// Archived groups are permanently dismissed by the user (see
	// requeueStatuses); they are excluded from every incident list and every
	// account incident count unless explicitly requested by status.
	notArchivedSQL = "eg.status <> 'archived'"
)

// requeueStatuses defines error group statuses eligible for re-queuing when a new
// occurrence arrives. Active states (queued, analyzing) are excluded to prevent double-queuing.
// Note: "archived" is intentionally excluded — archived groups are considered permanently
// dismissed by the user and should not auto-requeue on recurrence. Users must manually
// unarchive first if they want the group re-investigated.
var requeueStatuses = map[string]struct{}{
	"resolved":    {},
	"needs_human": {},
	"merged":      {},
}

// isRequeueEligible returns true if a group should be re-queued on recurrence.
// Non-retriable reason codes (e.g. policy_blocked) are excluded regardless of
// status so an auto-resolved permanent failure remains terminal.
func isRequeueEligible(groupStatus string, reasonCode *string) bool {
	if _, ok := requeueStatuses[groupStatus]; !ok {
		return false
	}
	if reasonCode != nil {
		if _, nonRetriable := nonRetriableReasonCodes[*reasonCode]; nonRetriable {
			return false
		}
	}
	return true
}

// eventInActionScope reports whether an event from environmentID may trigger
// automation. The statement snapshot visible when this query executes decides
// how a concurrent settings update is applied.
func eventInActionScope(ctx context.Context, tx pgx.Tx, projectID, environmentID string) (bool, error) {
	var inScope bool
	err := tx.QueryRow(ctx,
		`SELECT (NOT p.action_scope_enabled)
		        OR EXISTS (
		          SELECT 1 FROM project_action_environments pae
		          WHERE pae.project_id = p.id AND pae.environment_id = $2
		        )
		 FROM projects p WHERE p.id = $1`,
		projectID, environmentID,
	).Scan(&inScope)
	if err != nil {
		return false, fmt.Errorf("action scope check: %w", err)
	}
	return inScope, nil
}

// releaseNotOlder reports whether candidate is the resolved release or newer,
// ranked by first-seen time. First-seen uses server-recorded created_at (not the
// client-supplied timestamp) so a back-dated event cannot poison release ordering
// and silently suppress a genuine regression. Gating applies only when both
// releases are known; an empty or unranked side falls back to reopening.
func (q *Queries) releaseNotOlder(ctx context.Context, tx pgx.Tx, projectID, candidate, resolvedRelease string) (bool, error) {
	if candidate == "" || resolvedRelease == "" || candidate == resolvedRelease {
		return true, nil
	}

	const query = `
		SELECT
			(SELECT min(created_at) FROM error_events WHERE project_id = $1 AND release = $2),
			(SELECT min(created_at) FROM error_events WHERE project_id = $1 AND release = $3)`
	var candidateFirstSeen, resolvedFirstSeen *time.Time
	if err := tx.QueryRow(ctx, query, projectID, candidate, resolvedRelease).Scan(&candidateFirstSeen, &resolvedFirstSeen); err != nil {
		return true, err
	}
	if candidateFirstSeen == nil || resolvedFirstSeen == nil {
		return true, nil
	}
	return !candidateFirstSeen.Before(*resolvedFirstSeen), nil
}

// === Error groups ===

type ErrorGroup struct {
	ID                     string
	ProjectID              string
	Fingerprint            string
	Title                  string
	FirstSeen              time.Time
	LastSeen               time.Time
	OccurrenceCount        int
	AffectedUsersCount     int
	Status                 string
	Kind                   string
	Platform               *string
	EnvironmentID          *string
	AdjudicationStatus     *string
	ReasonCode             *string
	ReasonMessage          *string
	Remediation            *string
	Confidence             *string
	PrURL                  *string
	RootCause              *string
	SuggestedMitigation    *string
	InvestigationReadiness *string
	VerificationEvidence   []byte
	CandidateDiff          *string
	ImpactClass            *string
	ImpactVisits           *int64
	ImpactVisitsRecovered  *int64
	HasSavedDiff           bool
	SignalType             *string
	ElementSelector        *string
	PageURLNormalized      *string
	PriorityScore          *float64
	PriorityInputs         []byte
	PriorityScoredAt       *time.Time
	CreatedAt              time.Time
	UpdatedAt              time.Time
	MergedAt               *time.Time
	ResolvedAt             *time.Time
	ArchivedAt             *time.Time
}

type IngestParams struct {
	ProjectID            string
	DefaultEnvironmentID string
	EnvironmentLabel     string
	ErrorType            string
	ErrorMessage         string
	StackTraceRaw        string
	// Fingerprint is the Go ingest path's explicit fingerprint selection. The
	// legacy grouping path requires it; CaptureError uses it when the handler
	// selected a curated family or debug-ID fingerprint and otherwise computes
	// the raw fallback itself.
	Fingerprint    string
	Title          string
	Breadcrumbs    string // JSON, defaults to "[]"
	Context        string // JSON, defaults to "{}"
	Release        string // source map lookup
	DebugMeta      string // JSON, defaults to {"images":[]}
	NetworkTimings string // JSON array, defaults to "[]"
	CommitSHA      string // optional lowercase Git object ID
	SessionID      string // links error event to replay
	Platform       string // javascript | python | future wire token; empty defaults to javascript
	// EventTime is the validated client-side event time (issue #27). Zero
	// means "unknown" and falls back to server arrival time. It feeds
	// error_events.timestamp and group/junction impact times; created_at
	// always keeps server arrival time.
	EventTime time.Time

	// B2B end-user identity (optional, extracted from context.user)
	EndUserID          string
	EndUserEmail       string
	EndUserAccountID   string
	EndUserAccountName string
}

type IngestResult struct {
	EventID             string
	GroupID             string
	JobID               string
	IsNew               bool
	Requeued            bool // true if an existing group was re-queued due to recurrence policy
	EnvironmentOutcome  EnvironmentOutcome
	EnvironmentDiverged bool
}

// evidencePinDays keeps incident-linked recordings available while the
// incident is fresh. The retention hard cap remains authoritative.
const evidencePinDays = 30

// InsertErrorEventAndGroup atomically inserts an error event, upserts the error group,
// and creates a queue job — all in a single transaction.
func (q *Queries) InsertErrorEventAndGroup(ctx context.Context, p IngestParams) (*IngestResult, error) {
	if p.Breadcrumbs == "" {
		p.Breadcrumbs = "[]"
	}
	if p.Context == "" {
		p.Context = "{}"
	}
	if p.DebugMeta == "" {
		p.DebugMeta = `{"images":[]}`
	}
	if p.NetworkTimings == "" {
		p.NetworkTimings = "[]"
	}
	if p.Platform == "" {
		p.Platform = "javascript"
	}

	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	var environmentID string
	var environmentOutcome EnvironmentOutcome
	var environmentDiverged bool
	if p.SessionID != "" {
		var sessionEnvironmentName string
		err = tx.QueryRow(ctx, `
			SELECT s.environment_id, e.name
			FROM sessions s
			JOIN environments e ON e.id = s.environment_id AND e.project_id = s.project_id
			WHERE s.id = $1 AND s.project_id = $2 AND s.status <> 'deleting'`,
			p.SessionID, p.ProjectID,
		).Scan(&environmentID, &sessionEnvironmentName)
		if err == nil {
			environmentOutcome = EnvironmentOutcomeSession
			if p.EnvironmentLabel != "" && environmentNamePattern.MatchString(p.EnvironmentLabel) {
				environmentDiverged = p.EnvironmentLabel != sessionEnvironmentName
			} else {
				environmentDiverged = p.DefaultEnvironmentID != environmentID
			}
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("read authoritative session environment: %w", err)
		}
	}
	if environmentID == "" {
		environmentID, environmentOutcome, err = resolveEnvironmentTx(
			ctx, tx, p.ProjectID, p.DefaultEnvironmentID, p.EnvironmentLabel,
		)
		if err != nil {
			return nil, fmt.Errorf("resolve environment: %w", err)
		}
	}

	now := time.Now()

	// Client event time (issue #27): when the browser told us when the error
	// happened, persist that; otherwise fall back to server arrival time.
	eventTime := p.EventTime
	if eventTime.IsZero() {
		eventTime = now
	}

	// 1. Insert error event
	var eventID string
	err = tx.QueryRow(ctx,
		`INSERT INTO error_events (project_id, environment_id, timestamp, error_type, error_message, stack_trace_raw, breadcrumbs, context, release, session_id, platform, debug_meta, commit_sha, network_timings)
		 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12::jsonb, $13, $14::jsonb)
		 RETURNING id`,
		p.ProjectID, environmentID, eventTime, p.ErrorType, p.ErrorMessage, p.StackTraceRaw, p.Breadcrumbs, p.Context, nilIfEmpty(p.Release), nilIfEmpty(p.SessionID), p.Platform, p.DebugMeta, nilIfEmpty(p.CommitSHA), p.NetworkTimings,
	).Scan(&eventID)
	if err != nil {
		return nil, fmt.Errorf("insert error event: %w", err)
	}

	// Pin the referenced always-on recording in the same transaction as the
	// event insert. An unknown session id intentionally matches zero rows: old
	// SDKs and out-of-order delivery must not make event ingestion fail.
	if p.SessionID != "" {
		if _, err := tx.Exec(ctx,
			`UPDATE sessions
			    SET retain_until = GREATEST(
			        COALESCE(retain_until, 'epoch'::timestamptz),
			        now() + make_interval(days => $3))
			  WHERE id = $1 AND project_id = $2`,
			p.SessionID, p.ProjectID, evidencePinDays,
		); err != nil {
			return nil, fmt.Errorf("pin session for evidence: %w", err)
		}
	}

	// 2. Upsert error group
	var groupID string
	var isNew bool
	err = tx.QueryRow(ctx,
		`INSERT INTO error_groups (project_id, fingerprint, title, first_seen, last_seen, occurrence_count, sample_event_id, platform)
		 VALUES ($1, $2, $3, $4, $4, 1, $5, $6)
		 ON CONFLICT (project_id, fingerprint) DO UPDATE
		   SET first_seen = LEAST(error_groups.first_seen, $4),
		       last_seen = GREATEST(error_groups.last_seen, $4),
		       occurrence_count = error_groups.occurrence_count + 1,
		       sample_event_id = $5,
		       platform = COALESCE(error_groups.platform, EXCLUDED.platform),
		       updated_at = now()
		   WHERE error_groups.kind = 'error'
		 RETURNING id, (xmax = 0) AS is_new`,
		p.ProjectID, p.Fingerprint, p.Title, eventTime, eventID, p.Platform,
	).Scan(&groupID, &isNew)
	if err != nil {
		return nil, fmt.Errorf("upsert error group: %w", err)
	}

	// 3. Link the event and maintain its environment rollup in one database
	// round trip while the error_groups row is still locked. Client event times
	// can arrive out of order, so both bounds are monotonic.
	_, err = tx.Exec(ctx,
		`WITH linked_event AS (
		   UPDATE error_events SET error_group_id = $1 WHERE id = $2
		   RETURNING id
		 )
		 INSERT INTO error_group_environments
		   (error_group_id, environment_id, first_seen, last_seen, occurrence_count)
		 SELECT eg.id, $3, $4, $4, 1
		 FROM linked_event
		 JOIN error_groups eg ON eg.id = $1 AND eg.kind = 'error'
		 ON CONFLICT (error_group_id, environment_id) DO UPDATE
		   SET first_seen = LEAST(error_group_environments.first_seen, EXCLUDED.first_seen),
		       last_seen = GREATEST(error_group_environments.last_seen, EXCLUDED.last_seen),
		       occurrence_count = error_group_environments.occurrence_count + 1`,
		groupID, eventID, environmentID, eventTime,
	)
	if err != nil {
		return nil, fmt.Errorf("link event and upsert environment rollup: %w", err)
	}

	// 3b. Upsert end-user identity if provided (B2B tracking)
	if p.EndUserID != "" {
		var endUserDBID string
		err = tx.QueryRow(ctx,
			`INSERT INTO end_users (project_id, external_user_id, external_account_id, email, account_name, first_seen, last_seen)
			 VALUES ($1, $2, $3, $4, $5, $6, $6)
			 ON CONFLICT (project_id, external_user_id) DO UPDATE
			   SET last_seen = $6,
			       email = COALESCE(NULLIF($4, ''), end_users.email),
			       external_account_id = COALESCE(NULLIF($3, ''), end_users.external_account_id),
			       account_name = COALESCE(NULLIF($5, ''), end_users.account_name)
			 RETURNING id`,
			p.ProjectID, p.EndUserID, nilIfEmpty(p.EndUserAccountID), nilIfEmpty(p.EndUserEmail), nilIfEmpty(p.EndUserAccountName), now,
		).Scan(&endUserDBID)
		if err != nil {
			return nil, fmt.Errorf("upsert end user: %w", err)
		}

		// Link event to end user
		_, err = tx.Exec(ctx,
			`UPDATE error_events SET end_user_id = $1 WHERE id = $2`,
			endUserDBID, eventID,
		)
		if err != nil {
			return nil, fmt.Errorf("link event to end user: %w", err)
		}

		// Upsert affected user junction
		_, err = tx.Exec(ctx,
			`INSERT INTO error_group_affected_users (error_group_id, end_user_id, first_seen, last_seen, occurrence_count)
			 VALUES ($1, $2, $3, $3, 1)
			 ON CONFLICT (error_group_id, end_user_id) DO UPDATE
			   SET first_seen = LEAST(error_group_affected_users.first_seen, $3),
			       last_seen = GREATEST(error_group_affected_users.last_seen, $3),
			       occurrence_count = error_group_affected_users.occurrence_count + 1`,
			groupID, endUserDBID, eventTime,
		)
		if err != nil {
			return nil, fmt.Errorf("upsert affected user: %w", err)
		}

		// Update affected_users_count on the error group
		_, err = tx.Exec(ctx,
			`UPDATE error_groups
			 SET affected_users_count = (SELECT COUNT(*) FROM error_group_affected_users WHERE error_group_id = $1)
			 WHERE id = $1`,
			groupID,
		)
		if err != nil {
			return nil, fmt.Errorf("update affected users count: %w", err)
		}
	}

	// 4. Create queue work only when this occurrence is in the project's action
	// scope. Events and rollups above are recorded regardless of scope.
	var jobID string
	var requeued bool
	inScope, err := eventInActionScope(ctx, tx, p.ProjectID, environmentID)
	if err != nil {
		return nil, err
	}

	enqueueFirst := func() error {
		if err := tx.QueryRow(ctx,
			`INSERT INTO error_group_jobs (error_group_id, project_id, event_id)
			 VALUES ($1, $2, $3)
			 RETURNING id`,
			groupID, p.ProjectID, eventID,
		).Scan(&jobID); err != nil {
			return fmt.Errorf("insert queue job: %w", err)
		}

		if _, err := tx.Exec(ctx,
			`UPDATE error_groups SET status = 'queued' WHERE id = $1`,
			groupID,
		); err != nil {
			return fmt.Errorf("update group status to queued: %w", err)
		}

		if err := publishIssueCreated(ctx, tx, q.DashboardURL, p.ProjectID, environmentID, groupID, p.Title, eventTime); err != nil {
			return fmt.Errorf("publish issue.created: %w", err)
		}
		return nil
	}

	if isNew && inScope {
		if err := enqueueFirst(); err != nil {
			return nil, err
		}
	} else if !isNew && inScope {
		var groupStatus, resolvedInRelease string
		var reasonCode *string
		var hasJobs bool
		err = tx.QueryRow(ctx,
			`SELECT status, reason_code, COALESCE(resolved_in_release, ''),
			        EXISTS (SELECT 1 FROM error_group_jobs j
			                WHERE j.error_group_id = error_groups.id
			                  AND j.project_id = error_groups.project_id)
			 FROM error_groups WHERE id = $1 AND project_id = $2`,
			groupID, p.ProjectID,
		).Scan(&groupStatus, &reasonCode, &resolvedInRelease, &hasJobs)
		if err != nil {
			return nil, fmt.Errorf("query group status for requeue check: %w", err)
		}
		if groupStatus == "new" && !hasJobs {
			if err := enqueueFirst(); err != nil {
				return nil, err
			}
		} else {
			eligible := isRequeueEligible(groupStatus, reasonCode)
			if eligible && (groupStatus == "resolved" || groupStatus == "merged") {
				notOlder, err := q.releaseNotOlder(ctx, tx, p.ProjectID, p.Release, resolvedInRelease)
				if err != nil {
					return nil, fmt.Errorf("release-order check: %w", err)
				}
				eligible = notOlder
			}

			if eligible {
				err = tx.QueryRow(ctx,
					`INSERT INTO error_group_jobs (error_group_id, project_id, event_id)
					 VALUES ($1, $2, $3)
					 RETURNING id`,
					groupID, p.ProjectID, eventID,
				).Scan(&jobID)
				if err != nil {
					return nil, fmt.Errorf("insert requeue job: %w", err)
				}

				_, err = tx.Exec(ctx,
					`UPDATE error_groups
					 SET status = 'queued',
					     reason_code = NULL,
					     reason_message = NULL,
					     remediation = NULL,
					     candidate_diff = NULL,
					     verification_evidence = NULL,
					     root_cause = NULL,
					     suggested_mitigation = NULL,
					     merged_at = NULL,
					     resolved_at = NULL,
					     archived_at = NULL,
					     resolved_in_release = NULL,
					     resolved_reason = NULL,
					     updated_at = now()
					 WHERE id = $1`,
					groupID,
				)
				if err != nil {
					return nil, fmt.Errorf("update group status to queued on requeue: %w", err)
				}
				requeued = true
			}
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit tx: %w", err)
	}

	return &IngestResult{
		EventID:             eventID,
		GroupID:             groupID,
		JobID:               jobID,
		IsNew:               isNew,
		Requeued:            requeued,
		EnvironmentOutcome:  environmentOutcome,
		EnvironmentDiverged: environmentDiverged,
	}, nil
}

// ErrorGroupFilters provides optional filtering for ListErrorGroups.
type ErrorGroupFilters struct {
	AccountID     string  // filter by external_account_id via affected occurrences
	EndUserID     string  // filter by external_user_id via affected occurrences
	Status        string  // filter by error group status
	EnvironmentID *string // filter by environment UUID; nil means all environments
	Platform      string  // filter by platform; implies kind='error' (friction incidents have no platform)
	Kind          string  // filter by incident kind: 'friction' or 'error'
}

// ListErrorGroups returns error groups for a project with optional filters. Tenant-scoped.
func (q *Queries) ListErrorGroups(ctx context.Context, projectID string, filters *ErrorGroupFilters) ([]ErrorGroup, error) {
	args := []interface{}{projectID}
	argIdx := 2

	var environmentArg, statusArg, accountArg, endUserArg, platformArg, kindArg int
	if filters != nil && filters.EnvironmentID != nil && *filters.EnvironmentID != "" {
		environmentArg = argIdx
		args = append(args, *filters.EnvironmentID)
		argIdx++
	}
	if filters != nil {
		if filters.Status != "" {
			statusArg = argIdx
			args = append(args, filters.Status)
			argIdx++
		}
		if filters.Platform != "" {
			platformArg = argIdx
			args = append(args, filters.Platform)
			argIdx++
		}
		if filters.Kind != "" {
			kindArg = argIdx
			args = append(args, filters.Kind)
			argIdx++
		}
		if filters.AccountID != "" {
			accountArg = argIdx
			args = append(args, filters.AccountID)
			argIdx++
		}
		if filters.EndUserID != "" {
			endUserArg = argIdx
			args = append(args, filters.EndUserID)
			argIdx++
		}
	}

	identityPredicate := func(alias string) string {
		predicates := make([]string, 0, 2)
		if accountArg != 0 {
			predicates = append(predicates, fmt.Sprintf("%s.external_account_id = $%d", alias, accountArg))
		}
		if endUserArg != 0 {
			predicates = append(predicates, fmt.Sprintf("%s.external_user_id = $%d", alias, endUserArg))
		}
		return strings.Join(predicates, " AND ")
	}

	var query string
	// Applied only when the caller passed no status: an explicit status filter
	// already scopes the query, and appending this would break status=archived.
	hideArchived := statusArg == 0
	if environmentArg == 0 {
		wheres := []string{"eg.project_id = $1", visibleCandidateSQL}
		if hideArchived {
			wheres = append(wheres, notArchivedSQL)
		}
		if statusArg != 0 {
			wheres = append(wheres, fmt.Sprintf("eg.status = $%d", statusArg))
		}
		if platformArg != 0 {
			wheres = append(wheres, fmt.Sprintf("eg.platform = $%d AND eg.kind = 'error'", platformArg))
		}
		if kindArg != 0 {
			wheres = append(wheres, fmt.Sprintf("eg.kind = $%d", kindArg))
		}
		if accountArg != 0 || endUserArg != 0 {
			wheres = append(wheres, fmt.Sprintf(`EXISTS (
				SELECT 1
				FROM error_group_affected_users eau
				JOIN end_users identity_user ON identity_user.id = eau.end_user_id
				WHERE eau.error_group_id = eg.id AND %s
			)`, identityPredicate("identity_user")))
		}
		query = `SELECT eg.id, eg.project_id, eg.fingerprint, eg.title, eg.first_seen, eg.last_seen,
		               eg.occurrence_count, eg.affected_users_count, eg.status, eg.kind, eg.platform,
		               eg.environment_id, eg.adjudication_status,
		               eg.reason_code, eg.reason_message, eg.remediation,
		               eg.confidence, eg.pr_url, eg.root_cause, eg.suggested_mitigation, ` + investigationReadinessSQL("eg") + `,
		               eg.impact_class, eg.impact_visits, eg.impact_visits_recovered,
		               NULLIF(btrim(eg.candidate_diff), '') IS NOT NULL AS has_saved_diff,
		               eg.signal_type, eg.element_selector, eg.page_url_normalized,
		               eg.priority_score, eg.priority_inputs, eg.priority_scored_at,
		               eg.created_at, eg.updated_at,
		               eg.merged_at, eg.resolved_at, eg.archived_at
		        FROM error_groups eg
		        WHERE ` + strings.Join(wheres, " AND ") + `
		        ORDER BY COALESCE(eg.priority_score, 0) DESC, eg.last_seen DESC, eg.id DESC
		        LIMIT 100`
	} else {
		errorWheres := []string{
			fmt.Sprintf("ege.environment_id = $%d", environmentArg),
			"eg.project_id = $1",
			"eg.kind = 'error'",
			visibleCandidateSQL,
		}
		frictionWheres := []string{
			"eg.project_id = $1",
			"eg.kind = 'friction'",
			fmt.Sprintf("eg.environment_id = $%d", environmentArg),
			visibleCandidateSQL,
		}
		if hideArchived {
			errorWheres = append(errorWheres, notArchivedSQL)
			frictionWheres = append(frictionWheres, notArchivedSQL)
		}
		if statusArg != 0 {
			statusClause := fmt.Sprintf("eg.status = $%d", statusArg)
			errorWheres = append(errorWheres, statusClause)
			frictionWheres = append(frictionWheres, statusClause)
		}
		if kindArg != 0 {
			// Each arm already pins its own kind, so the arm that does not match
			// contributes nothing. Applying this to both arms is what makes that
			// true: adding it to only one would leave the other unfiltered.
			kindClause := fmt.Sprintf("eg.kind = $%d", kindArg)
			errorWheres = append(errorWheres, kindClause)
			frictionWheres = append(frictionWheres, kindClause)
		}
		if platformArg != 0 {
			// A platform filter implies kind='error'. Friction incidents carry
			// no platform, so their UNION arm must contribute nothing rather
			// than relying on NULL comparison semantics to hide them.
			errorWheres = append(errorWheres, fmt.Sprintf("eg.platform = $%d", platformArg))
			frictionWheres = append(frictionWheres, "false")
		}
		if accountArg != 0 || endUserArg != 0 {
			errorWheres = append(errorWheres, fmt.Sprintf(`(
				EXISTS (
					SELECT 1
					FROM error_events identity_event
					JOIN end_users identity_user ON identity_user.id = identity_event.end_user_id
					WHERE identity_event.error_group_id = eg.id
					  AND identity_event.project_id = eg.project_id
					  AND identity_event.environment_id = $%d
					  AND %s
				)
				OR EXISTS (
					SELECT 1
					FROM friction_signals identity_signal
					JOIN end_users identity_signal_user ON identity_signal_user.id = identity_signal.end_user_id
					WHERE identity_signal.incident_id = eg.id
					  AND identity_signal.project_id = eg.project_id
					  AND identity_signal.environment_id = $%d
					  AND identity_signal.retracted_at IS NULL
					  AND identity_signal.superseded_by IS NULL
					  AND %s
				)
			)`, environmentArg, identityPredicate("identity_user"), environmentArg,
				identityPredicate("identity_signal_user")))
			frictionWheres = append(frictionWheres, fmt.Sprintf(`EXISTS (
				SELECT 1
				FROM error_group_affected_users eau
				JOIN end_users identity_user ON identity_user.id = eau.end_user_id
				WHERE eau.error_group_id = eg.id AND %s
			)`, identityPredicate("identity_user")))
		}
		query = fmt.Sprintf(`WITH candidates AS (
			(SELECT ege.error_group_id AS id, ege.first_seen, ege.last_seen, ege.occurrence_count,
			        eg.priority_score, eg.priority_inputs, eg.priority_scored_at
			 FROM error_group_environments ege
			 JOIN error_groups eg ON eg.id = ege.error_group_id
			 WHERE %s
			 ORDER BY COALESCE(eg.priority_score, 0) DESC, ege.last_seen DESC, ege.error_group_id DESC
			 LIMIT 100)
			UNION ALL
			(SELECT eg.id, eg.first_seen, eg.last_seen, eg.occurrence_count::bigint,
			        eg.priority_score, eg.priority_inputs, eg.priority_scored_at
			 FROM error_groups eg
			 WHERE %s
			 ORDER BY COALESCE(eg.priority_score, 0) DESC, eg.last_seen DESC, eg.id DESC
			 LIMIT 100)
		)
		SELECT eg.id, eg.project_id, eg.fingerprint, eg.title, candidates.first_seen, candidates.last_seen,
		       candidates.occurrence_count, eg.affected_users_count, eg.status, eg.kind, eg.platform,
		       eg.environment_id, eg.adjudication_status,
		       eg.reason_code, eg.reason_message, eg.remediation,
		       eg.confidence, eg.pr_url, eg.root_cause, eg.suggested_mitigation, `+investigationReadinessSQL("eg")+`,
		       eg.impact_class, eg.impact_visits, eg.impact_visits_recovered,
		       NULLIF(btrim(eg.candidate_diff), '') IS NOT NULL AS has_saved_diff,
		       eg.signal_type, eg.element_selector, eg.page_url_normalized,
		       candidates.priority_score, candidates.priority_inputs, candidates.priority_scored_at,
		       eg.created_at, eg.updated_at,
		       eg.merged_at, eg.resolved_at, eg.archived_at
		FROM candidates
		JOIN error_groups eg ON eg.id = candidates.id
		ORDER BY COALESCE(candidates.priority_score, 0) DESC, candidates.last_seen DESC, candidates.id DESC
		LIMIT 100`, strings.Join(errorWheres, " AND "), strings.Join(frictionWheres, " AND "))
	}

	rows, err := q.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list error groups: %w", err)
	}
	defer rows.Close()

	var groups []ErrorGroup
	for rows.Next() {
		var g ErrorGroup
		err := rows.Scan(
			&g.ID, &g.ProjectID, &g.Fingerprint, &g.Title, &g.FirstSeen, &g.LastSeen,
			&g.OccurrenceCount, &g.AffectedUsersCount, &g.Status, &g.Kind, &g.Platform,
			&g.EnvironmentID, &g.AdjudicationStatus,
			&g.ReasonCode, &g.ReasonMessage, &g.Remediation,
			&g.Confidence, &g.PrURL, &g.RootCause, &g.SuggestedMitigation, &g.InvestigationReadiness,
			&g.ImpactClass, &g.ImpactVisits, &g.ImpactVisitsRecovered, &g.HasSavedDiff,
			&g.SignalType, &g.ElementSelector, &g.PageURLNormalized,
			&g.PriorityScore, &g.PriorityInputs, &g.PriorityScoredAt,
			&g.CreatedAt, &g.UpdatedAt,
			&g.MergedAt, &g.ResolvedAt, &g.ArchivedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("scan error group: %w", err)
		}
		groups = append(groups, g)
	}
	return groups, rows.Err()
}

// === B2B read queries ===

type EndUser struct {
	ID                string
	ProjectID         string
	ExternalUserID    string
	ExternalAccountID *string
	Email             *string
	DisplayName       *string
	FirstSeen         time.Time
	LastSeen          time.Time
}

type AffectedUser struct {
	EndUserID         string
	ExternalUserID    string
	Email             *string
	ExternalAccountID *string
	FirstSeen         time.Time
	LastSeen          time.Time
	OccurrenceCount   int
}

type Account struct {
	ExternalAccountID string
	AccountName       *string
	UserCount         int
	IncidentCount     int
	LastSeen          time.Time
}

// ListAffectedUsers returns end users affected by a specific error group. Tenant-scoped.
func (q *Queries) ListAffectedUsers(ctx context.Context, projectID, errorGroupID string) ([]AffectedUser, error) {
	rows, err := q.pool.Query(ctx,
		`SELECT eu.id, eu.external_user_id, eu.email, eu.external_account_id,
		        eau.first_seen, eau.last_seen, eau.occurrence_count
		 FROM error_group_affected_users eau
		 JOIN end_users eu ON eu.id = eau.end_user_id
		 JOIN error_groups eg ON eg.id = eau.error_group_id
		 WHERE eau.error_group_id = $1 AND eg.project_id = $2
		   AND eg.status <> 'candidate'
		 ORDER BY eau.last_seen DESC`,
		errorGroupID, projectID,
	)
	if err != nil {
		return nil, fmt.Errorf("list affected users: %w", err)
	}
	defer rows.Close()

	var users []AffectedUser
	for rows.Next() {
		var u AffectedUser
		if err := rows.Scan(&u.EndUserID, &u.ExternalUserID, &u.Email, &u.ExternalAccountID,
			&u.FirstSeen, &u.LastSeen, &u.OccurrenceCount); err != nil {
			return nil, fmt.Errorf("scan affected user: %w", err)
		}
		users = append(users, u)
	}
	return users, rows.Err()
}

// ListAccounts returns aggregated accounts for a project. Tenant-scoped.
func (q *Queries) ListAccounts(ctx context.Context, projectID string, query *string) ([]Account, error) {
	// The visibility predicates live in the ON clause, not WHERE: in WHERE they
	// would demote the LEFT JOIN to an inner join and drop accounts with zero
	// visible incidents out of the list entirely. Counting eg.id rather than
	// eau.error_group_id lets filtered-out rows contribute NULL.
	sql := `SELECT eu.external_account_id,
	               MAX(eu.account_name) AS account_name,
	               COUNT(DISTINCT eu.id) AS user_count,
	               COUNT(DISTINCT eg.id) AS incident_count,
	               MAX(eu.last_seen) AS last_seen
	        FROM end_users eu
	        LEFT JOIN error_group_affected_users eau ON eau.end_user_id = eu.id
	        LEFT JOIN error_groups eg ON eg.id = eau.error_group_id
	             AND eg.project_id = eu.project_id
	             AND ` + notArchivedSQL + `
	             AND ` + visibleCandidateSQL + `
	        WHERE eu.project_id = $1 AND eu.external_account_id IS NOT NULL`

	args := []interface{}{projectID}
	if query != nil && *query != "" {
		sql += ` AND (eu.external_account_id ILIKE $2 OR eu.account_name ILIKE $2)`
		args = append(args, "%"+*query+"%")
	}
	sql += ` GROUP BY eu.external_account_id ORDER BY last_seen DESC LIMIT 100`

	rows, err := q.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("list accounts: %w", err)
	}
	defer rows.Close()

	var accounts []Account
	for rows.Next() {
		var a Account
		if err := rows.Scan(&a.ExternalAccountID, &a.AccountName, &a.UserCount,
			&a.IncidentCount, &a.LastSeen); err != nil {
			return nil, fmt.Errorf("scan account: %w", err)
		}
		accounts = append(accounts, a)
	}
	return accounts, rows.Err()
}

// GetAccountByID returns a single account by exact external_account_id. Tenant-scoped.
func (q *Queries) GetAccountByID(ctx context.Context, projectID, externalAccountID string) (*Account, error) {
	var a Account
	err := q.pool.QueryRow(ctx,
		// Same ON-clause / COUNT(eg.id) shape as ListAccounts; see the comment
		// there for why the predicates cannot move into WHERE.
		`SELECT eu.external_account_id,
		        MAX(eu.account_name) AS account_name,
		        COUNT(DISTINCT eu.id) AS user_count,
		        COUNT(DISTINCT eg.id) AS incident_count,
		        MAX(eu.last_seen) AS last_seen
		 FROM end_users eu
		 LEFT JOIN error_group_affected_users eau ON eau.end_user_id = eu.id
		 LEFT JOIN error_groups eg ON eg.id = eau.error_group_id
		      AND eg.project_id = eu.project_id
		      AND `+notArchivedSQL+`
		      AND `+visibleCandidateSQL+`
		 WHERE eu.project_id = $1 AND eu.external_account_id = $2
		 GROUP BY eu.external_account_id`,
		projectID, externalAccountID,
	).Scan(&a.ExternalAccountID, &a.AccountName, &a.UserCount, &a.IncidentCount, &a.LastSeen)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get account by id: %w", err)
	}
	return &a, nil
}

// GetErrorGroup returns a single error group by ID, scoped to project. Tenant-scoped.
func (q *Queries) GetErrorGroup(ctx context.Context, projectID, groupID string) (*ErrorGroup, error) {
	var g ErrorGroup
	err := q.pool.QueryRow(ctx,
		`SELECT g.id, g.project_id, g.fingerprint, g.title, g.first_seen, g.last_seen,
		        g.occurrence_count, g.affected_users_count, g.status, g.kind, g.platform,
		        g.environment_id, g.adjudication_status,
		        g.reason_code, g.reason_message, g.remediation,
		        g.confidence, g.pr_url, g.root_cause, g.suggested_mitigation, `+investigationReadinessSQL("g")+`,
		        g.verification_evidence, g.candidate_diff,
		        g.impact_class, g.impact_visits, g.impact_visits_recovered,
		        NULLIF(btrim(g.candidate_diff), '') IS NOT NULL AS has_saved_diff,
		        g.signal_type, g.element_selector, g.page_url_normalized,
		        g.priority_score, g.priority_inputs, g.priority_scored_at,
		        g.created_at, g.updated_at,
		        g.merged_at, g.resolved_at, g.archived_at
		 FROM error_groups g
		 WHERE g.id = $1 AND g.project_id = $2
		   AND (g.status <> 'candidate' OR g.adjudication_status = 'unchecked')`,
		groupID, projectID,
	).Scan(
		&g.ID, &g.ProjectID, &g.Fingerprint, &g.Title, &g.FirstSeen, &g.LastSeen,
		&g.OccurrenceCount, &g.AffectedUsersCount, &g.Status, &g.Kind, &g.Platform,
		&g.EnvironmentID, &g.AdjudicationStatus,
		&g.ReasonCode, &g.ReasonMessage, &g.Remediation,
		&g.Confidence, &g.PrURL, &g.RootCause, &g.SuggestedMitigation, &g.InvestigationReadiness,
		&g.VerificationEvidence, &g.CandidateDiff,
		&g.ImpactClass, &g.ImpactVisits, &g.ImpactVisitsRecovered, &g.HasSavedDiff,
		&g.SignalType, &g.ElementSelector, &g.PageURLNormalized,
		&g.PriorityScore, &g.PriorityInputs, &g.PriorityScoredAt,
		&g.CreatedAt, &g.UpdatedAt,
		&g.MergedAt, &g.ResolvedAt, &g.ArchivedAt,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get error group: %w", err)
	}
	return &g, nil
}

// GetLatestAgentTaskBrief returns the newest validated decision's brief for a
// group. The handler additionally requires readiness=eligible before serving it.
func (q *Queries) GetLatestAgentTaskBrief(ctx context.Context, projectID, groupID string) (*string, error) {
	var brief *string
	err := q.pool.QueryRow(ctx,
		`SELECT NULLIF(btrim(diagnosis->>'agentTaskBrief'), '')
		 FROM diagnosis_decisions
		 WHERE project_id = $1 AND error_group_id = $2
		   AND outcome IN ('code_fix', 'not_actionable')
		 ORDER BY decided_at DESC, id DESC
		 LIMIT 1`,
		projectID, groupID,
	).Scan(&brief)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get latest agent task brief: %w", err)
	}
	return brief, nil
}

// SampleEvent is the representative event for an error group, used by the
// dashboard detail view. Tenant-scoped through the owning group's project_id.
type SampleEvent struct {
	Timestamp     time.Time
	Platform      string
	ErrorType     string
	ErrorMessage  string
	StackTraceRaw string
	Breadcrumbs   []byte // JSONB passthrough
	Context       []byte // JSONB passthrough
}

// GetSampleEvent returns the sample event for a group, scoped to the project.
// Ordinary candidate rows are hidden workflow records and stay invisible here.
// The join requires the event to belong to the same project AND the same group:
// sample_event_id has no FK, so a corrupt pointer must not serve another
// tenant's event (cross-project) or another incident's evidence (same-project).
func (q *Queries) GetSampleEvent(ctx context.Context, projectID, groupID string) (*SampleEvent, error) {
	var ev SampleEvent
	err := q.pool.QueryRow(ctx,
		`SELECT e."timestamp", e.platform, e.error_type, e.error_message,
		        e.stack_trace_raw, e.breadcrumbs, e.context
		 FROM error_groups g
		 JOIN error_events e ON e.id = g.sample_event_id
		   AND e.project_id = g.project_id AND e.error_group_id = g.id
		 WHERE g.id = $1 AND g.project_id = $2
		   AND (g.status <> 'candidate' OR g.adjudication_status = 'unchecked')`,
		groupID, projectID,
	).Scan(&ev.Timestamp, &ev.Platform, &ev.ErrorType, &ev.ErrorMessage,
		&ev.StackTraceRaw, &ev.Breadcrumbs, &ev.Context)
	if err != nil {
		return nil, err
	}
	return &ev, nil
}

// GroupEnvironment is one environment-specific occurrence summary for an
// incident. Error-kind rows come from the rollup; friction-kind rows come from
// the group's environment-scoped identity.
type GroupEnvironment struct {
	ID              string
	Name            string
	OccurrenceCount int64
	LastSeen        time.Time
}

// ListGroupEnvironments returns an incident's environment breakdown, scoped to
// its owning project and explicitly kind-gated.
func (q *Queries) ListGroupEnvironments(ctx context.Context, projectID, groupID string) ([]GroupEnvironment, error) {
	rows, err := q.pool.Query(ctx, `
		SELECT environment_id, environment_name, occurrence_count, last_seen
		FROM (
		  SELECT env.id AS environment_id, env.name AS environment_name,
		         ege.occurrence_count, ege.last_seen
		  FROM error_groups eg
		  JOIN error_group_environments ege ON ege.error_group_id = eg.id
		  JOIN environments env ON env.id = ege.environment_id
		  WHERE eg.id = $1 AND eg.project_id = $2 AND eg.kind = 'error'
		  UNION ALL
		  SELECT env.id, env.name, eg.occurrence_count::bigint, eg.last_seen
		  FROM error_groups eg
		  JOIN environments env ON env.id = eg.environment_id
		  WHERE eg.id = $1 AND eg.project_id = $2 AND eg.kind = 'friction'
		) group_environments
		ORDER BY last_seen DESC, environment_id`, groupID, projectID)
	if err != nil {
		return nil, fmt.Errorf("list group environments: %w", err)
	}
	defer rows.Close()

	var environments []GroupEnvironment
	for rows.Next() {
		var environment GroupEnvironment
		if err := rows.Scan(
			&environment.ID,
			&environment.Name,
			&environment.OccurrenceCount,
			&environment.LastSeen,
		); err != nil {
			return nil, fmt.Errorf("scan group environment: %w", err)
		}
		environments = append(environments, environment)
	}
	return environments, rows.Err()
}

// GetLatestJobTraceURL returns the trace_url from the most recent job for an error group.
// Tenant-scoped via error_groups join.
func (q *Queries) GetLatestJobTraceURL(ctx context.Context, projectID, errorGroupID string) (*string, error) {
	var traceURL *string
	err := q.pool.QueryRow(ctx,
		`SELECT egj.trace_url
		 FROM error_group_jobs egj
		 JOIN error_groups eg ON eg.id = egj.error_group_id
		 WHERE egj.error_group_id = $1 AND eg.project_id = $2
		 ORDER BY egj.created_at DESC LIMIT 1`,
		errorGroupID, projectID,
	).Scan(&traceURL)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get latest job trace url: %w", err)
	}
	return traceURL, nil
}

// TriggerFixJob atomically transitions an incident from its kind-specific
// fix-triggerable state to 'fixing' and creates a human-triggered fix job.
// Returns the new job ID or an error. Tenant-scoped.
func (q *Queries) TriggerFixJob(ctx context.Context, projectID, groupID, guidance string) (string, error) {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return "", fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	// Atomically check and transition status
	var id, kind string
	err = tx.QueryRow(ctx,
		`UPDATE error_groups
			 SET status = 'fixing', terminal_fix_job_id = NULL, updated_at = now()
		 WHERE id = $1 AND project_id = $2
		   AND (
		     (kind = 'error' AND status = 'investigated')
		     OR
		     (kind = 'friction' AND status = 'awaiting_approval')
		   )
		 RETURNING id, kind`,
		groupID, projectID,
	).Scan(&id, &kind)
	if err == pgx.ErrNoRows {
		return "", ErrNotInvestigated
	}
	if err != nil {
		return "", fmt.Errorf("update error group status: %w", err)
	}

	// Error fixes inherit the episode, input version, and source investigation
	// that produced the report. The worker can then read the same frozen evidence
	// for investigation and fixing. Friction has no episode-backed admission path
	// yet, so its human fix keeps the existing sample anchor.
	var jobID string
	if kind == "error" {
		// input_version stays NULL on human fixes: the one-job-per-round-and-
		// version unique index has no status predicate, so a version-stamped
		// human retry after a terminal automatic fix (for example a PR closed
		// unmerged returning the group to 'investigated') would collide with
		// the spent slot and 500. The episode still pins the frozen evidence;
		// the active-job index still prevents concurrent duplicates.
		err = tx.QueryRow(ctx,
			`INSERT INTO error_group_jobs
			   (error_group_id,project_id,job_type,guidance,triggered_by,platform,
			    source_job_id,event_id,episode_id,input_version)
			 SELECT $1,$2,'fix',$3,'human',g.platform,
			        j.id,j.event_id,j.episode_id,NULL
			   FROM error_groups g
			   JOIN LATERAL (
			     SELECT j.id,j.event_id,j.episode_id,j.input_version
			       FROM error_group_jobs j
			       JOIN issue_episodes ep
			         ON ep.id=j.episode_id AND ep.project_id=j.project_id
			        AND ep.canonical_issue_id=j.error_group_id AND ep.closed_at IS NULL
			      WHERE j.error_group_id=$1 AND j.project_id=$2
			        AND j.job_type='investigate' AND j.status='completed'
			        AND j.episode_id IS NOT NULL AND j.input_version IS NOT NULL
			      ORDER BY j.created_at DESC,j.id DESC
			      LIMIT 1
			   ) j ON true
			  WHERE g.id=$1 AND g.project_id=$2
			 RETURNING id`,
			groupID, projectID, nilIfEmpty(guidance),
		).Scan(&jobID)
		if err == pgx.ErrNoRows {
			// No completed investigation in an open work round (pre-cutover
			// rows have NULL episodes; a closed round has no live evidence).
			// This is a fix-triggerability condition, not a server fault: the
			// sentinel maps to the 409 the dashboard understands. The status
			// transition above must not stick either way.
			return "", ErrNotInvestigated
		}
	} else {
		err = tx.QueryRow(ctx,
			`INSERT INTO error_group_jobs
			   (error_group_id,project_id,job_type,guidance,triggered_by,platform,event_id)
			 VALUES ($1,$2,'fix',$3,'human',
			        (SELECT platform FROM error_groups WHERE id=$1 AND project_id=$2),
			        (SELECT sample_event_id FROM error_groups WHERE id=$1 AND project_id=$2))
			 RETURNING id`,
			groupID, projectID, nilIfEmpty(guidance),
		).Scan(&jobID)
	}
	if err != nil {
		return "", fmt.Errorf("insert fix job: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("commit tx: %w", err)
	}

	return jobID, nil
}

// EnqueueSetupPrJob enqueues a setup_pr job for the project. Idempotent: returns
// the existing pending/claimed job id if one is already in flight. Tenant-scoped by orgID.
func (q *Queries) EnqueueSetupPrJob(ctx context.Context, orgID, projectID string) (string, error) {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return "", fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	var repo *string
	err = tx.QueryRow(ctx, `SELECT github_repo FROM projects WHERE id = $1 AND org_id = $2`, projectID, orgID).Scan(&repo)
	if err == pgx.ErrNoRows {
		return "", ErrNoGithubRepo
	}
	if err != nil {
		return "", fmt.Errorf("lookup project: %w", err)
	}
	if repo == nil || *repo == "" {
		return "", ErrNoGithubRepo
	}

	var existing string
	err = tx.QueryRow(ctx,
		`SELECT id FROM error_group_jobs
		  WHERE project_id = $1 AND job_type = 'setup_pr' AND status IN ('pending','claimed')
		  ORDER BY created_at DESC LIMIT 1`,
		projectID,
	).Scan(&existing)
	if err == nil {
		if cErr := tx.Commit(ctx); cErr != nil {
			return "", fmt.Errorf("commit tx: %w", cErr)
		}
		return existing, nil
	}
	if err != pgx.ErrNoRows {
		return "", fmt.Errorf("check in-flight: %w", err)
	}

	var jobID string
	err = tx.QueryRow(ctx,
		`INSERT INTO error_group_jobs (project_id, job_type) VALUES ($1, 'setup_pr') RETURNING id`,
		projectID,
	).Scan(&jobID)
	if err != nil {
		return "", fmt.Errorf("insert setup_pr job: %w", err)
	}
	if _, err = tx.Exec(ctx, `UPDATE projects SET setup_pr_status = 'pending', setup_pr_error = NULL WHERE id = $1`, projectID); err != nil {
		return "", fmt.Errorf("set project status: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("commit tx: %w", err)
	}
	return jobID, nil
}

type SetupPrInfo struct {
	Status   *string
	PRURL    *string
	PRNumber *int
	Error    *string
}

func (q *Queries) GetSetupPrStatus(ctx context.Context, orgID, projectID string) (*SetupPrInfo, error) {
	var s SetupPrInfo
	err := q.pool.QueryRow(ctx,
		`SELECT setup_pr_status, setup_pr_url, setup_pr_number, setup_pr_error
		   FROM projects WHERE id = $1 AND org_id = $2`,
		projectID, orgID,
	).Scan(&s.Status, &s.PRURL, &s.PRNumber, &s.Error)
	if err != nil {
		return nil, fmt.Errorf("get setup pr status: %w", err)
	}
	return &s, nil
}

// === Replay + Source Map ===

// ReplayArtifact represents a screenshot or recording artifact for a replay.
type ReplayArtifact struct {
	ID          string
	Kind        string
	ObjectKey   string
	ContentType string
	Width       int
	Height      int
}

// InsertReplay creates a session_replays row.
func (q *Queries) InsertReplay(ctx context.Context, id, projectID string, errorGroupID, errorEventID *string,
	sessionID, triggerType, pageURL, startedAt, endedAt, objectKey string) error {
	_, err := q.pool.Exec(ctx,
		`INSERT INTO session_replays (id, project_id, error_group_id, error_event_id, session_id, trigger_type, page_url, started_at, ended_at, status, object_key)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10)`,
		id, projectID, errorGroupID, errorEventID, sessionID, triggerType,
		nilIfEmpty(pageURL), nilIfEmpty(startedAt), nilIfEmpty(endedAt), objectKey)
	return err
}

// GroupIDForEvent returns the error_group_id for an error event within a
// project, plus whether the event exists there at all. A captured event awaits
// identity settlement with a NULL group, so "known event, empty group" is a
// normal state the caller must distinguish from "unknown event". Used by
// ReplayInit to derive the group when the SDK only sends an error_event_id
// (contract C1).
func (q *Queries) GroupIDForEvent(ctx context.Context, eventID, projectID string) (gid string, found bool, err error) {
	var stored *string
	err = q.pool.QueryRow(ctx,
		`SELECT error_group_id FROM error_events WHERE id = $1 AND project_id = $2`,
		eventID, projectID).Scan(&stored)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	if stored == nil {
		return "", true, nil
	}
	return *stored, true, nil
}

// GetReplayObjectKey returns the recording object key for a completed replay within a
// project, or "" if not found / not complete. Used by the retrieval endpoint.
func (q *Queries) GetReplayObjectKey(ctx context.Context, replayID, projectID string) (string, error) {
	var key string
	err := q.pool.QueryRow(ctx,
		`SELECT object_key FROM session_replays
		  WHERE id = $1 AND project_id = $2 AND status = 'complete' AND object_key IS NOT NULL`,
		replayID, projectID).Scan(&key)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return key, err
}

// ReplayIDForGroup returns the best-matching completed replay for an error group.
// Matches direct group links, direct event links, and the legacy sample-event
// session_id fallback. Results are ranked by match precision (group > event >
// session) and then recency, so an unrelated replay that merely shares a session_id
// can never outrank an exact group/event match. Keep in sync with worker correlation.
func (q *Queries) ReplayIDForGroup(ctx context.Context, errorGroupID, projectID string) (string, error) {
	var id string
	err := q.pool.QueryRow(ctx,
		`SELECT sr.id
		   FROM session_replays sr
		  WHERE sr.project_id = $2
		    AND sr.status = 'complete'
		    AND (
		      sr.error_group_id = $1
		      OR sr.error_event_id IN (
		        SELECT ee.id FROM error_events ee
		        WHERE ee.error_group_id = $1 AND ee.project_id = $2
		      )
		      OR sr.session_id IN (
		        SELECT ee.session_id FROM error_events ee
		        JOIN error_groups eg ON eg.sample_event_id = ee.id
		        WHERE eg.id = $1 AND eg.project_id = $2 AND ee.session_id IS NOT NULL
		      )
		    )
		  ORDER BY
		    CASE
		      WHEN sr.error_group_id = $1 THEN 0
		      WHEN sr.error_event_id IN (
		        SELECT ee.id FROM error_events ee
		        WHERE ee.error_group_id = $1 AND ee.project_id = $2
		      ) THEN 1
		      ELSE 2
		    END,
		    sr.created_at DESC
		  LIMIT 1`,
		errorGroupID, projectID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return id, err
}

// ReplayBelongsToProject checks ownership of a replay within a project.
func (q *Queries) ReplayBelongsToProject(ctx context.Context, replayID, projectID string) (bool, error) {
	var exists bool
	err := q.pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM session_replays WHERE id = $1 AND project_id = $2)`,
		replayID, projectID).Scan(&exists)
	return exists, err
}

// FailReplay marks a pending replay terminally failed. Project-scoped.
func (q *Queries) FailReplay(ctx context.Context, replayID, projectID, reason string) error {
	tag, err := q.pool.Exec(ctx,
		`UPDATE session_replays
		    SET status = 'failed'
		  WHERE id = $1 AND project_id = $2 AND status = 'pending'`,
		replayID, projectID,
	)
	if err != nil {
		return fmt.Errorf("fail replay: %w", err)
	}
	if tag.RowsAffected() == 0 {
		slog.Warn("fail replay matched no pending row", "replay_id", replayID, "reason", reason)
	}
	return nil
}

// CompleteReplay atomically inserts artifacts and updates replay status.
// Amendment #11: wrapped in pgx transaction for atomicity.
func (q *Queries) CompleteReplay(ctx context.Context, replayID string, signals string,
	artifacts []ReplayArtifact) error {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	for _, a := range artifacts {
		_, err := tx.Exec(ctx,
			`INSERT INTO session_replay_artifacts (id, replay_id, kind, object_key, content_type, width, height)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			a.ID, replayID, a.Kind, a.ObjectKey, a.ContentType, a.Width, a.Height)
		if err != nil {
			return fmt.Errorf("insert artifact: %w", err)
		}
	}

	_, err = tx.Exec(ctx,
		`UPDATE session_replays SET status = 'complete', replay_signals = $1::jsonb WHERE id = $2`,
		signals, replayID)
	if err != nil {
		return fmt.Errorf("update replay status: %w", err)
	}

	return tx.Commit(ctx)
}

// UpdateErrorGroupStatus updates the status of an error group.
// If status is 'needs_human', reason fields are required.
type StatusUpdate struct {
	ProjectID     string
	GroupID       string
	Status        string
	ReasonCode    *string
	ReasonMessage *string
	Remediation   *string
	Confidence    *string
	PrURL         *string
}

func (q *Queries) UpdateErrorGroupStatus(ctx context.Context, u StatusUpdate) error {
	if u.Status == "needs_human" {
		if u.ReasonCode == nil || u.ReasonMessage == nil || u.Remediation == nil {
			return fmt.Errorf("needs_human requires reason_code, reason_message, and remediation")
		}
	}

	ct, err := q.pool.Exec(ctx,
		`UPDATE error_groups
		 SET status = $3::error_group_status,
		     reason_code = $4,
		     reason_message = $5,
		     remediation = $6,
		     confidence = $7,
		     pr_url = $8,
		     updated_at = now()
		 WHERE id = $1 AND project_id = $2`,
		u.GroupID, u.ProjectID, u.Status,
		u.ReasonCode, u.ReasonMessage, u.Remediation,
		u.Confidence, u.PrURL,
	)
	if err != nil {
		return fmt.Errorf("update error group status: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return fmt.Errorf("update error group status: no matching row for group %s in project %s", u.GroupID, u.ProjectID)
	}
	return nil
}

// === Resolution lifecycle ===

// PRWebhookResult reports how a pull_request webhook was applied.
type PRWebhookResult struct {
	GroupID        string
	Duplicate      bool // receipt for this github_delivery_id already existed; no transition performed
	CleanupBranch  string
	InstallationID *int64
}

// EnqueueProductContextPush schedules repository understanding for every
// project connected to githubRepo. A newer push supersedes an active refresh;
// an immutable receipt makes every delivery idempotent.
func (q *Queries) EnqueueProductContextPush(
	ctx context.Context,
	githubRepo, deliveryID, commitSHA string,
	changedPaths []string,
) (int64, error) {
	payload, err := json.Marshal(map[string]any{
		"delivery_id":   deliveryID,
		"commit_sha":    commitSHA,
		"changed_paths": changedPaths,
	})
	if err != nil {
		return 0, fmt.Errorf("encode product-context push: %w", err)
	}
	tag, err := q.pool.Exec(ctx,
		`WITH received AS (
		   INSERT INTO product_context_push_receipts (project_id, delivery_id, commit_sha)
		   SELECT p.id, $2, $4
		     FROM projects p
		    WHERE p.github_repo = $1
		   ON CONFLICT DO NOTHING
		   RETURNING project_id
		 )
		 INSERT INTO error_group_jobs (project_id, job_type, triggered_by, payload)
		 SELECT received.project_id, 'product_context', 'auto', $3::jsonb
		   FROM received
		 ON CONFLICT (project_id, job_type)
		   WHERE job_type = 'product_context' AND status IN ('pending','claimed')
		 DO UPDATE SET
		   status = 'pending',
		   worker_id = NULL,
		   claimed_at = NULL,
		   lease_expires_at = NULL,
		   available_at = now(),
		   attempts = 0,
		   last_error = NULL,
		   payload = jsonb_set(EXCLUDED.payload, '{changed_paths}', 'null'::jsonb),
		   updated_at = now()`,
		githubRepo, deliveryID, string(payload), commitSHA,
	)
	if err != nil {
		return 0, fmt.Errorf("enqueue product context for push: %w", err)
	}
	return tag.RowsAffected(), nil
}

func loadDraftBranchCleanup(ctx context.Context, tx pgx.Tx, groupID string) (string, *int64, error) {
	var branch string
	var installationID *int64
	err := tx.QueryRow(ctx,
		`SELECT r.branch_name, o.github_installation_id
		 FROM delivery_reservations r
		 JOIN projects p ON p.id = r.project_id
		 JOIN orgs o ON o.id = p.org_id
		 WHERE r.error_group_id = $1 AND r.posture = 'draft'`,
		groupID,
	).Scan(&branch, &installationID)
	if err == pgx.ErrNoRows {
		return "", nil, nil
	}
	if err != nil {
		return "", nil, fmt.Errorf("load draft branch cleanup: %w", err)
	}
	return branch, installationID, nil
}

// ProcessPRWebhook records an immutable pr_outcomes receipt before transitioning
// the matched group. GitHub delivery IDs make redeliveries idempotent. A
// closed-unmerged ready PR returns to the incident's fix-triggerable state. A
// closed-unmerged draft returns to needs_human with its original reason and
// candidate evidence intact.
//
// A merge for a PR whose group already left its PR-owning state (closed
// unmerged, then
// reopened and merged) is recovered through the earlier close receipt, which
// still links repo+pr_number to the group. Without that, the merge would be
// silently dropped and the incident would stay fix-eligible. A close/merge
// arriving before the worker records the PR still no-matches — recovering
// that needs a delivery inbox and is deliberately out of scope here.
//
// Matching by github_repo + pr_number + a PR-owning status assumes that tuple
// is unique in practice. If multiple projects share the same repo, one arbitrary
// match is used; revisit this for multi-project-per-repo support.
func (q *Queries) ProcessPRWebhook(ctx context.Context, githubRepo string, prNumber int, merged bool, deliveryID string, occurredAt time.Time) (PRWebhookResult, error) {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return PRWebhookResult{}, fmt.Errorf("begin PR webhook transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	// Check idempotency before matching the group: the first delivery moves the
	// group out of its PR-owning status or clears its PR fields.
	var seenGroupID, seenOutcome string
	err = tx.QueryRow(ctx,
		`SELECT error_group_id, outcome FROM pr_outcomes WHERE github_delivery_id = $1`,
		deliveryID,
	).Scan(&seenGroupID, &seenOutcome)
	if err == nil {
		result := PRWebhookResult{GroupID: seenGroupID, Duplicate: true}
		if seenOutcome == "closed" {
			result.CleanupBranch, result.InstallationID, err = loadDraftBranchCleanup(ctx, tx, seenGroupID)
			if err != nil {
				return PRWebhookResult{}, err
			}
		}
		return result, nil
	}
	if err != pgx.ErrNoRows {
		return PRWebhookResult{}, fmt.Errorf("check PR webhook delivery id: %w", err)
	}

	var groupID, projectID, kind, groupStatus string
	var fixJobID *string
	var cleanupBranch *string
	var installationID *int64
	err = tx.QueryRow(ctx,
		`SELECT eg.id, eg.project_id, eg.kind, eg.status, eg.pr_fix_job_id,
		        r.branch_name, o.github_installation_id
		 FROM error_groups eg
		 JOIN projects p ON eg.project_id = p.id
		 JOIN orgs o ON o.id = p.org_id
		 LEFT JOIN delivery_reservations r
		   ON r.error_group_id = eg.id AND r.project_id = eg.project_id
		 WHERE p.github_repo = $1
		   AND eg.pr_number = $2
		   AND eg.status IN ('pr_created', 'pr_draft')
		 FOR UPDATE OF eg`,
		githubRepo, prNumber,
	).Scan(&groupID, &projectID, &kind, &groupStatus, &fixJobID, &cleanupBranch, &installationID)
	if err == pgx.ErrNoRows {
		// A concurrent delivery can pass the first receipt check, wait on the
		// group's row lock, then find that the winner already transitioned it.
		// Recheck the immutable receipt so that race still reports duplicate.
		err = tx.QueryRow(ctx,
			`SELECT error_group_id, outcome FROM pr_outcomes WHERE github_delivery_id = $1`,
			deliveryID,
		).Scan(&seenGroupID, &seenOutcome)
		if err == nil {
			result := PRWebhookResult{GroupID: seenGroupID, Duplicate: true}
			if seenOutcome == "closed" {
				result.CleanupBranch, result.InstallationID, err = loadDraftBranchCleanup(ctx, tx, seenGroupID)
				if err != nil {
					return PRWebhookResult{}, err
				}
			}
			return result, nil
		}
		if err != pgx.ErrNoRows {
			return PRWebhookResult{}, fmt.Errorf("recheck PR webhook delivery id: %w", err)
		}
		if !merged {
			return PRWebhookResult{}, nil
		}
		return recoverReopenedMerge(ctx, tx, githubRepo, prNumber, deliveryID, occurredAt)
	}
	if err != nil {
		return PRWebhookResult{}, fmt.Errorf("match PR webhook group: %w", err)
	}

	outcome := "closed"
	if merged {
		outcome = "merged"
	}
	ct, err := tx.Exec(ctx,
		`INSERT INTO pr_outcomes
		   (error_group_id, project_id, pr_number, outcome, github_delivery_id, fix_job_id, occurred_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 ON CONFLICT (github_delivery_id) DO NOTHING`,
		groupID, projectID, prNumber, outcome, deliveryID, fixJobID, occurredAt,
	)
	if err != nil {
		return PRWebhookResult{}, fmt.Errorf("insert PR outcome: %w", err)
	}
	if ct.RowsAffected() == 0 {
		if err := tx.Commit(ctx); err != nil {
			return PRWebhookResult{}, fmt.Errorf("commit duplicate PR webhook: %w", err)
		}
		return PRWebhookResult{GroupID: groupID, Duplicate: true}, nil
	}
	if fixJobID != nil {
		// max_attempts 10: with the worker's capped exponential backoff this
		// tolerates a multi-hour Langfuse outage; the default 3 dead-letters
		// the score after ~5 minutes, and nothing re-enqueues from pr_outcomes.
		if _, err := tx.Exec(ctx,
			`INSERT INTO error_group_jobs (error_group_id, project_id, job_type, max_attempts, payload)
			 VALUES ($1, $2, 'score_sync', 10, jsonb_build_object(
			   'fix_job_id', $3::text, 'outcome', $4::text, 'delivery_id', $5::text,
			   'occurred_at', to_char($6::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))`,
			groupID, projectID, *fixJobID, outcome, deliveryID, occurredAt,
		); err != nil {
			return PRWebhookResult{}, fmt.Errorf("enqueue score_sync: %w", err)
		}
	}

	if merged {
		// merged_at anchors the silence checker's post-merge window, so use the
		// PR's actual closed_at rather than webhook-processing time: a delayed
		// delivery must not reclassify post-merge regressions as pre-merge noise.
		_, err = tx.Exec(ctx,
			`UPDATE error_groups
			 SET status = 'merged', merged_at = $2, updated_at = now()
			 WHERE id = $1`,
			groupID, occurredAt,
		)
	} else if groupStatus == "pr_draft" {
		// Keep the reason, candidate diff, and verification evidence written when
		// the draft was opened. They become the actionable needs_human writeup.
		_, err = tx.Exec(ctx,
			`UPDATE error_groups
			 SET status = 'needs_human',
			     needs_human_at = now(),
			     pr_url = NULL,
			     pr_number = NULL,
			     pr_fix_job_id = NULL,
			     updated_at = now()
			 WHERE id = $1`,
			groupID,
		)
	} else {
		_, err = tx.Exec(ctx,
			`UPDATE error_groups
			 SET status = CASE WHEN kind = 'friction'
			                   THEN 'awaiting_approval'::error_group_status
			                   ELSE 'investigated'::error_group_status END,
			     pr_url = NULL,
			     pr_number = NULL,
			     pr_fix_job_id = NULL,
			     updated_at = now()
			 WHERE id = $1`,
			groupID,
		)
	}
	if err != nil {
		return PRWebhookResult{}, fmt.Errorf("transition on PR %s: %w", outcome, err)
	}

	// A PR webhook is authoritative for the delivery lifecycle. A draft no
	// longer needs a live watcher after either merge or close, and the durable
	// reservation must stop counting toward the project's open-draft cap. Keep
	// these writes in the same transaction as the incident transition.
	if groupStatus == "pr_draft" {
		if _, err := tx.Exec(ctx,
			`UPDATE error_group_jobs
			 SET status = 'completed', updated_at = now()
			 WHERE error_group_id = $1
			   AND project_id = $2
			   AND job_type = 'ci_watch'
			   AND status IN ('pending', 'claimed')`,
			groupID, projectID,
		); err != nil {
			return PRWebhookResult{}, fmt.Errorf("cancel draft CI watcher: %w", err)
		}
	}
	if _, err := tx.Exec(ctx,
		`UPDATE delivery_reservations
		 SET state = 'closed', updated_at = now()
		 WHERE error_group_id = $1 AND project_id = $2`,
		groupID, projectID,
	); err != nil {
		return PRWebhookResult{}, fmt.Errorf("close delivery reservation: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return PRWebhookResult{}, fmt.Errorf("commit PR webhook transaction: %w", err)
	}
	result := PRWebhookResult{GroupID: groupID}
	if !merged && groupStatus == "pr_draft" && cleanupBranch != nil {
		result.CleanupBranch = *cleanupBranch
		result.InstallationID = installationID
	}
	return result, nil
}

// recoverReopenedMerge handles a merge webhook for a PR whose group already
// left pr_created: the unmerged close wrote a receipt and cleared the group's
// PR fields, then the PR was reopened and merged. The earlier receipt still
// links repo+pr_number to the group, so the merge receipt is recorded (with the
// close receipt's fix_job_id for attribution) and — only if the group is still
// parked where the close left it — the group transitions to merged. Any other
// status means the incident moved on (a newer fix may be in flight); the
// receipt is still written so outcome counts stay accurate, but state is left
// alone.
func recoverReopenedMerge(ctx context.Context, tx pgx.Tx, githubRepo string, prNumber int, deliveryID string, occurredAt time.Time) (PRWebhookResult, error) {
	var groupID, projectID, status string
	var fixJobID *string
	err := tx.QueryRow(ctx,
		`SELECT eg.id, eg.project_id, eg.status, o.fix_job_id
		 FROM pr_outcomes o
		 JOIN error_groups eg ON o.error_group_id = eg.id
		 JOIN projects p ON eg.project_id = p.id
		 WHERE p.github_repo = $1
		   AND o.pr_number = $2
		 ORDER BY o.occurred_at DESC, o.created_at DESC
		 LIMIT 1
		 FOR UPDATE OF eg`,
		githubRepo, prNumber,
	).Scan(&groupID, &projectID, &status, &fixJobID)
	if err == pgx.ErrNoRows {
		return PRWebhookResult{}, nil
	}
	if err != nil {
		return PRWebhookResult{}, fmt.Errorf("recover reopened PR merge: %w", err)
	}

	ct, err := tx.Exec(ctx,
		`INSERT INTO pr_outcomes
		   (error_group_id, project_id, pr_number, outcome, github_delivery_id, fix_job_id, occurred_at)
		 VALUES ($1, $2, $3, 'merged', $4, $5, $6)
		 ON CONFLICT (github_delivery_id) DO NOTHING`,
		groupID, projectID, prNumber, deliveryID, fixJobID, occurredAt,
	)
	if err != nil {
		return PRWebhookResult{}, fmt.Errorf("insert recovered PR outcome: %w", err)
	}
	if ct.RowsAffected() == 0 {
		if err := tx.Commit(ctx); err != nil {
			return PRWebhookResult{}, fmt.Errorf("commit duplicate recovered PR webhook: %w", err)
		}
		return PRWebhookResult{GroupID: groupID, Duplicate: true}, nil
	}
	if fixJobID != nil {
		// max_attempts 10: see the enqueue in ProcessPRWebhook.
		if _, err := tx.Exec(ctx,
			`INSERT INTO error_group_jobs (error_group_id, project_id, job_type, max_attempts, payload)
			 VALUES ($1, $2, 'score_sync', 10, jsonb_build_object(
			   'fix_job_id', $3::text, 'outcome', 'merged', 'delivery_id', $4::text,
			   'occurred_at', to_char($5::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))`,
			groupID, projectID, *fixJobID, deliveryID, occurredAt,
		); err != nil {
			return PRWebhookResult{}, fmt.Errorf("enqueue score_sync: %w", err)
		}
	}

	if status == "investigated" || status == "awaiting_approval" {
		if _, err := tx.Exec(ctx,
			`UPDATE error_groups
			 SET status = 'merged', merged_at = $2, updated_at = now()
			 WHERE id = $1`,
			groupID, occurredAt,
		); err != nil {
			return PRWebhookResult{}, fmt.Errorf("transition recovered PR merge: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return PRWebhookResult{}, fmt.Errorf("commit recovered PR webhook: %w", err)
	}
	return PRWebhookResult{GroupID: groupID}, nil
}

// ResolveErrorGroup manually transitions an error group to resolved.
// Allowed from any status except archived. Tenant-scoped.
func (q *Queries) ResolveErrorGroup(ctx context.Context, projectID, groupID string) error {
	ct, err := q.pool.Exec(ctx,
		`UPDATE error_groups
		 SET status = 'resolved',
		     resolved_at = now(),
		     resolved_reason = 'manual',
		     resolved_in_release = (
		       SELECT release FROM error_events
		       WHERE project_id = $1 AND release IS NOT NULL AND release <> ''
		       GROUP BY release ORDER BY min(created_at) DESC LIMIT 1
		     ),
		     updated_at = now()
		 WHERE id = $2 AND project_id = $1 AND status != 'archived'`,
		projectID, groupID,
	)
	if err != nil {
		return fmt.Errorf("resolve error group: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return fmt.Errorf("resolve error group: no matching row (group %s may be archived or not found)", groupID)
	}
	return nil
}

// ArchiveErrorGroup transitions an error group to archived from any status, and
// is idempotent: archiving an already-archived group succeeds without touching
// it. Tenant-scoped.
//
// The `status <> 'archived'` guard is what keeps a second archive from
// overwriting status_before_archive with 'archived', which would make unarchive
// unable to restore anything. It also makes the repeat case update zero rows,
// so zero rows no longer means "no such group" on its own — a double-click, or
// an archive issued from a stale list, would otherwise surface as 409 "incident
// not found". Ask which case it was before reporting a failure.
func (q *Queries) ArchiveErrorGroup(ctx context.Context, projectID, groupID string) error {
	ct, err := q.pool.Exec(ctx,
		`UPDATE error_groups
		 SET status_before_archive = status,
		     status = 'archived',
		     archived_at = now(),
		     updated_at = now()
		 WHERE id = $1 AND project_id = $2 AND status <> 'archived'`,
		groupID, projectID,
	)
	if err != nil {
		return fmt.Errorf("archive error group: %w", err)
	}
	if ct.RowsAffected() == 0 {
		var alreadyArchived bool
		if err := q.pool.QueryRow(ctx,
			`SELECT status = 'archived' FROM error_groups WHERE id = $1 AND project_id = $2`,
			groupID, projectID,
		).Scan(&alreadyArchived); err == nil && alreadyArchived {
			return nil
		}
		return fmt.Errorf("archive error group: no matching row for group %s in project %s", groupID, projectID)
	}
	return nil
}

// UnarchiveErrorGroup restores the pre-archive state. Rows archived before the
// saved-status column existed fall back to the previous kind-safe behavior.
func (q *Queries) UnarchiveErrorGroup(ctx context.Context, projectID, groupID string) error {
	ct, err := q.pool.Exec(ctx,
		`UPDATE error_groups
		 SET status = COALESCE(
		       status_before_archive,
		       CASE WHEN kind = 'friction' THEN 'insight'::error_group_status
		            ELSE 'investigated'::error_group_status END),
		     status_before_archive = NULL,
		     archived_at = NULL,
		     updated_at = now()
		 WHERE id = $1 AND project_id = $2 AND status = 'archived'`,
		groupID, projectID,
	)
	if err != nil {
		return fmt.Errorf("unarchive error group: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return fmt.Errorf("unarchive error group: group %s is not archived or not found", groupID)
	}
	return nil
}

// === Users ===

type User struct {
	ID             string
	OrgID          string
	Email          string
	PasswordHash   *string
	Name           string
	GitHubID       *int64
	GitHubUsername *string
	AvatarURL      *string
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

// === Auth identities and cloud provisioning ===

// UpsertIdentity records a provider subject for a user. Ownership is immutable:
// an existing mapping to another user returns ErrIdentityConflict.
func (q *Queries) UpsertIdentity(ctx context.Context, userID, provider, subject string) error {
	return q.UpsertIdentityDetails(ctx, userID, provider, subject, "", false)
}

// UpsertIdentityDetails also records the provider's current email verification
// assertion so invitation acceptance can be bound to a verified identity.
func (q *Queries) UpsertIdentityDetails(ctx context.Context, userID, provider, subject, providerEmail string, emailVerified bool) error {
	provider = strings.TrimSpace(provider)
	subject = strings.TrimSpace(subject)
	if userID == "" || provider == "" || subject == "" {
		return fmt.Errorf("upsert identity: user, provider, and subject are required")
	}
	providerEmail = NormalizeEmail(providerEmail)
	_, err := q.pool.Exec(ctx,
		`INSERT INTO auth_identities (user_id, provider, provider_subject, provider_email, email_verified)
		 VALUES ($1, $2, $3, NULLIF($4, ''), $5)
		 ON CONFLICT (provider, provider_subject) DO NOTHING`,
		userID, provider, subject, providerEmail, emailVerified)
	if err != nil {
		return fmt.Errorf("upsert identity: %w", err)
	}

	owner, err := q.GetUserIDByIdentity(ctx, provider, subject)
	if err != nil {
		return err
	}
	if owner != userID {
		return fmt.Errorf("%w: %s:%s", ErrIdentityConflict, provider, subject)
	}

	_, err = q.pool.Exec(ctx,
		`UPDATE auth_identities
		 SET provider_email = COALESCE(NULLIF($4, ''), provider_email),
		     email_verified = email_verified OR $5
		 WHERE user_id = $1 AND provider = $2 AND provider_subject = $3`,
		userID, provider, subject, providerEmail, emailVerified)
	if err != nil {
		return fmt.Errorf("update identity details: %w", err)
	}
	return nil
}

// GetUserIDByIdentity resolves a provider subject, returning "" when absent.
func (q *Queries) GetUserIDByIdentity(ctx context.Context, provider, subject string) (string, error) {
	var userID string
	err := q.pool.QueryRow(ctx,
		`SELECT user_id FROM auth_identities WHERE provider = $1 AND provider_subject = $2`,
		strings.TrimSpace(provider), strings.TrimSpace(subject)).Scan(&userID)
	if err == pgx.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("get user by identity: %w", err)
	}
	return userID, nil
}

// HasVerifiedIdentityEmail reports whether the local user authenticated an
// identity provider that verified the supplied normalized email address.
func (q *Queries) HasVerifiedIdentityEmail(ctx context.Context, userID, email string) (bool, error) {
	var verified bool
	err := q.pool.QueryRow(ctx,
		`SELECT EXISTS (
		   SELECT 1 FROM auth_identities
		   WHERE user_id = $1 AND email_verified AND lower(provider_email) = $2
		 )`, userID, NormalizeEmail(email)).Scan(&verified)
	if err != nil {
		return false, fmt.Errorf("check verified identity email: %w", err)
	}
	return verified, nil
}

// ProvisionFromIdentity creates or links a cloud identity atomically.
func (q *Queries) ProvisionFromIdentity(ctx context.Context, identity auth.Identity) (userID, orgID string, err error) {
	tx, err := q.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return "", "", fmt.Errorf("begin identity provisioning: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	userID, orgID, err = q.ProvisionFromIdentityTx(ctx, tx, identity)
	if err != nil {
		return "", "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", "", fmt.Errorf("commit identity provisioning: %w", err)
	}
	return userID, orgID, nil
}

// ProvisionFromIdentityTx is the transaction-scoped core, exposed so concurrency
// tests can begin two independent transactions at the same time.
func (q *Queries) ProvisionFromIdentityTx(ctx context.Context, tx pgx.Tx, identity auth.Identity) (string, string, error) {
	provider := strings.TrimSpace(identity.Provider)
	subject := strings.TrimSpace(identity.ProviderSubject)
	email := NormalizeEmail(identity.Email)
	if provider == "" || subject == "" || email == "" {
		return "", "", fmt.Errorf("provision identity: provider, subject, and email are required")
	}

	if err := lockIdentityTx(ctx, tx, provider, subject); err != nil {
		return "", "", err
	}
	if identity.EmailVerified {
		if err := lockEmailTx(ctx, tx, email); err != nil {
			return "", "", err
		}
	}

	var userID, orgID string
	err := tx.QueryRow(ctx,
		`SELECT u.id, u.org_id
		 FROM auth_identities ai JOIN users u ON u.id = ai.user_id
		 WHERE ai.provider = $1 AND ai.provider_subject = $2`, provider, subject).Scan(&userID, &orgID)
	if err != nil && err != pgx.ErrNoRows {
		return "", "", fmt.Errorf("resolve identity in provisioning: %w", err)
	}
	if err == nil {
		if _, err := tx.Exec(ctx,
			`INSERT INTO memberships (user_id, org_id, role) VALUES ($1, $2, 'owner')
			 ON CONFLICT (user_id, org_id) DO UPDATE SET role = 'owner'`, userID, orgID); err != nil {
			return "", "", fmt.Errorf("ensure identity owner membership: %w", err)
		}
		if _, err := tx.Exec(ctx,
			`UPDATE auth_identities SET provider_email = $3,
			 email_verified = email_verified OR $4
			 WHERE provider = $1 AND provider_subject = $2`, provider, subject, email, identity.EmailVerified); err != nil {
			return "", "", fmt.Errorf("refresh identity details: %w", err)
		}
		return userID, orgID, nil
	}

	if identity.EmailVerified {
		err = tx.QueryRow(ctx,
			`SELECT id, org_id FROM users WHERE lower(email) = $1`, email).Scan(&userID, &orgID)
		if err != nil && err != pgx.ErrNoRows {
			return "", "", fmt.Errorf("find verified email user: %w", err)
		}
	} else {
		var existingID string
		err = tx.QueryRow(ctx, `SELECT id FROM users WHERE lower(email) = $1`, email).Scan(&existingID)
		if err == nil {
			return "", "", fmt.Errorf("provision identity: unverified email cannot link an existing account")
		}
		if err != pgx.ErrNoRows {
			return "", "", fmt.Errorf("check unverified email: %w", err)
		}
		// Fail closed: never create an account for an unverified email. Otherwise
		// an attacker seeds a user+org under a victim's address, and the victim's
		// later verified login is adopted into that attacker-owned org.
		return "", "", fmt.Errorf("provision identity: unverified email cannot create an account")
	}

	if userID == "" {
		orgName := strings.TrimSpace(identity.Username)
		if orgName == "" {
			orgName = strings.TrimSpace(identity.Name)
		}
		if orgName == "" {
			orgName = strings.Split(email, "@")[0]
		}
		if err := tx.QueryRow(ctx,
			`INSERT INTO orgs (name) VALUES ($1) RETURNING id`, orgName).Scan(&orgID); err != nil {
			return "", "", fmt.Errorf("create identity org: %w", err)
		}
		if err := tx.QueryRow(ctx,
			`INSERT INTO users (org_id, email, password_hash, name, avatar_url)
			 VALUES ($1, $2, NULL, $3, NULLIF($4, '')) RETURNING id`,
			orgID, email, identity.Name, identity.AvatarURL).Scan(&userID); err != nil {
			return "", "", fmt.Errorf("create identity user: %w", err)
		}
	}

	if _, err := tx.Exec(ctx,
		`INSERT INTO memberships (user_id, org_id, role) VALUES ($1, $2, 'owner')
		 ON CONFLICT (user_id, org_id) DO UPDATE SET role = 'owner'`, userID, orgID); err != nil {
		return "", "", fmt.Errorf("ensure owner membership: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO auth_identities
		 (user_id, provider, provider_subject, provider_email, email_verified)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (provider, provider_subject) DO NOTHING`,
		userID, provider, subject, email, identity.EmailVerified); err != nil {
		return "", "", fmt.Errorf("insert provisioned identity: %w", err)
	}

	var owner string
	if err := tx.QueryRow(ctx,
		`SELECT user_id FROM auth_identities WHERE provider = $1 AND provider_subject = $2`,
		provider, subject).Scan(&owner); err != nil {
		return "", "", fmt.Errorf("validate provisioned identity: %w", err)
	}
	if owner != userID {
		return "", "", fmt.Errorf("%w: %s:%s", ErrIdentityConflict, provider, subject)
	}
	return userID, orgID, nil
}

// lockIdentityTx and lockEmailTx are shared by every identity provisioning
// path. A single key scheme ensures browser and agent onboarding serialize
// when they resolve the same human concurrently.
func lockIdentityTx(ctx context.Context, tx pgx.Tx, provider, subject string) error {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, provider+":"+subject); err != nil {
		return fmt.Errorf("lock identity provisioning: %w", err)
	}
	return nil
}

func lockEmailTx(ctx context.Context, tx pgx.Tx, email string) error {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, "email:"+email); err != nil {
		return fmt.Errorf("lock identity email: %w", err)
	}
	return nil
}

// GetUserByEmail looks up a user by email. Returns nil if not found.
// Note: no org_id scope — this is called during login before org is known.
// Email is globally unique so this is safe.
func (q *Queries) GetUserByEmail(ctx context.Context, email string) (*User, error) {
	var u User
	err := q.pool.QueryRow(ctx,
		`SELECT id, org_id, email, password_hash, name, github_id, github_username, avatar_url, created_at, updated_at
		 FROM users WHERE lower(email) = $1`,
		NormalizeEmail(email),
	).Scan(&u.ID, &u.OrgID, &u.Email, &u.PasswordHash, &u.Name, &u.GitHubID, &u.GitHubUsername, &u.AvatarURL, &u.CreatedAt, &u.UpdatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get user by email: %w", err)
	}
	return &u, nil
}

// GetUserByID looks up a user by ID. Returns nil if not found.
// Note: no org_id scope — called during token refresh where user_id comes
// from a validated refresh token. The user_id is the trust anchor.
func (q *Queries) GetUserByID(ctx context.Context, userID string) (*User, error) {
	var u User
	err := q.pool.QueryRow(ctx,
		`SELECT id, org_id, email, password_hash, name, github_id, github_username, avatar_url, created_at, updated_at
		 FROM users WHERE id = $1`,
		userID,
	).Scan(&u.ID, &u.OrgID, &u.Email, &u.PasswordHash, &u.Name, &u.GitHubID, &u.GitHubUsername, &u.AvatarURL, &u.CreatedAt, &u.UpdatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get user by id: %w", err)
	}
	return &u, nil
}

// GetUserByGitHubID looks up a user by their GitHub ID. Returns nil if not found.
// Note: no org_id scope — this is called during OAuth login before org is known.
func (q *Queries) GetUserByGitHubID(ctx context.Context, githubID int64) (*User, error) {
	var u User
	err := q.pool.QueryRow(ctx,
		`SELECT id, org_id, email, password_hash, name, github_id, github_username, avatar_url, created_at, updated_at
		 FROM users WHERE github_id = $1`,
		githubID,
	).Scan(&u.ID, &u.OrgID, &u.Email, &u.PasswordHash, &u.Name, &u.GitHubID, &u.GitHubUsername, &u.AvatarURL, &u.CreatedAt, &u.UpdatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get user by github id: %w", err)
	}
	return &u, nil
}

// CreateUserGitHub inserts a new user with GitHub identity (no password).
func (q *Queries) CreateUserGitHub(ctx context.Context, orgID, email, name string, githubID int64, githubUsername, avatarURL string) (*User, error) {
	var u User
	err := q.pool.QueryRow(ctx,
		`INSERT INTO users (org_id, email, name, github_id, github_username, avatar_url)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 RETURNING id, org_id, email, password_hash, name, github_id, github_username, avatar_url, created_at, updated_at`,
		orgID, NormalizeEmail(email), name, githubID, githubUsername, avatarURL,
	).Scan(&u.ID, &u.OrgID, &u.Email, &u.PasswordHash, &u.Name, &u.GitHubID, &u.GitHubUsername, &u.AvatarURL, &u.CreatedAt, &u.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("create github user: %w", err)
	}
	return &u, nil
}

// LinkUserGitHub links a GitHub identity to an existing user (e.g., email/password user
// who later authenticates via GitHub OAuth).
func (q *Queries) LinkUserGitHub(ctx context.Context, userID string, githubID int64, githubUsername, avatarURL string) error {
	_, err := q.pool.Exec(ctx,
		`UPDATE users SET github_id = $2, github_username = $3, avatar_url = $4, updated_at = now()
		 WHERE id = $1`,
		userID, githubID, githubUsername, avatarURL,
	)
	if err != nil {
		return fmt.Errorf("link github user: %w", err)
	}
	return nil
}

// UpdateUserGitHub refreshes GitHub profile fields on each login.
func (q *Queries) UpdateUserGitHub(ctx context.Context, userID, githubUsername, avatarURL, email string) error {
	_, err := q.pool.Exec(ctx,
		`UPDATE users SET github_username = $2, avatar_url = $3, email = $4, updated_at = now()
		 WHERE id = $1`,
		userID, githubUsername, avatarURL, NormalizeEmail(email),
	)
	if err != nil {
		return fmt.Errorf("update github user: %w", err)
	}
	return nil
}

// SetOrgGitHubInstallation stores the GitHub App installation ID on an org.
func (q *Queries) SetOrgGitHubInstallation(ctx context.Context, orgID string, installationID int64) error {
	_, err := q.pool.Exec(ctx,
		`UPDATE orgs SET github_installation_id = $2 WHERE id = $1`,
		orgID, installationID,
	)
	if err != nil {
		return fmt.Errorf("set org github installation: %w", err)
	}
	return nil
}

// GetOrgGitHubInstallation returns the GitHub App installation ID for an org.
// Returns 0 if not set.
func (q *Queries) GetOrgGitHubInstallation(ctx context.Context, orgID string) (int64, error) {
	var installationID *int64
	err := q.pool.QueryRow(ctx,
		`SELECT github_installation_id FROM orgs WHERE id = $1`,
		orgID,
	).Scan(&installationID)
	if err == pgx.ErrNoRows {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("get org github installation: %w", err)
	}
	if installationID == nil {
		return 0, nil
	}
	return *installationID, nil
}

// === Memberships and invitations (cloud-gated) ===

type Membership struct {
	UserID    string    `json:"user_id,omitempty"`
	OrgID     string    `json:"org_id"`
	OrgName   string    `json:"name"`
	Role      string    `json:"role"`
	CreatedAt time.Time `json:"created_at,omitempty"`
}

func (q *Queries) CreateMembership(ctx context.Context, userID, orgID, role string) error {
	_, err := q.pool.Exec(ctx,
		`INSERT INTO memberships (user_id, org_id, role) VALUES ($1, $2, $3)
		 ON CONFLICT (user_id, org_id) DO NOTHING`, userID, orgID, role)
	if err != nil {
		return fmt.Errorf("create membership: %w", err)
	}
	existing, err := q.GetMembership(ctx, userID, orgID)
	if err != nil {
		return err
	}
	if existing != role {
		return fmt.Errorf("create membership: existing role %q differs from %q", existing, role)
	}
	return nil
}

func (q *Queries) ListMembershipsByUser(ctx context.Context, userID string) ([]Membership, error) {
	rows, err := q.pool.Query(ctx,
		`SELECT m.user_id, m.org_id, o.name, m.role, m.created_at
		 FROM memberships m JOIN orgs o ON o.id = m.org_id
		 WHERE m.user_id = $1 ORDER BY m.created_at, m.org_id`, userID)
	if err != nil {
		return nil, fmt.Errorf("list user memberships: %w", err)
	}
	defer rows.Close()
	result := make([]Membership, 0)
	for rows.Next() {
		var membership Membership
		if err := rows.Scan(&membership.UserID, &membership.OrgID, &membership.OrgName, &membership.Role, &membership.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan membership: %w", err)
		}
		result = append(result, membership)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list user memberships: %w", err)
	}
	return result, nil
}

func (q *Queries) GetMembership(ctx context.Context, userID, orgID string) (string, error) {
	var role string
	err := q.pool.QueryRow(ctx,
		`SELECT role FROM memberships WHERE user_id = $1 AND org_id = $2`, userID, orgID).Scan(&role)
	if err == pgx.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("get membership: %w", err)
	}
	return role, nil
}

func (q *Queries) SetMembershipRole(ctx context.Context, userID, orgID, role string) error {
	ct, err := q.pool.Exec(ctx,
		`UPDATE memberships SET role = $3 WHERE user_id = $1 AND org_id = $2`, userID, orgID, role)
	if err != nil {
		return fmt.Errorf("set membership role: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return fmt.Errorf("set membership role: membership not found")
	}
	return nil
}

func (q *Queries) DeleteMembership(ctx context.Context, userID, orgID string) error {
	_, err := q.pool.Exec(ctx,
		`DELETE FROM memberships WHERE user_id = $1 AND org_id = $2`, userID, orgID)
	if err != nil {
		return fmt.Errorf("delete membership: %w", err)
	}
	return nil
}

type Invitation struct {
	ID         string     `json:"id"`
	OrgID      string     `json:"org_id"`
	Email      string     `json:"email"`
	Role       string     `json:"role"`
	InvitedBy  string     `json:"invited_by"`
	ExpiresAt  time.Time  `json:"expires_at"`
	CreatedAt  time.Time  `json:"created_at"`
	AcceptedAt *time.Time `json:"accepted_at,omitempty"`
	RevokedAt  *time.Time `json:"revoked_at,omitempty"`
}

func (q *Queries) CreateInvitation(ctx context.Context, orgID, email, role, invitedBy, tokenHash string, expiresAt time.Time) (*Invitation, error) {
	email = NormalizeEmail(email)
	tx, err := q.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("begin invitation create: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`UPDATE org_invitations SET revoked_at = now()
		 WHERE org_id = $1 AND lower(email) = $2 AND accepted_at IS NULL
		 AND revoked_at IS NULL AND expires_at <= now()`, orgID, email); err != nil {
		return nil, fmt.Errorf("expire old invitation: %w", err)
	}
	var invitation Invitation
	err = tx.QueryRow(ctx,
		`INSERT INTO org_invitations (org_id, email, role, invited_by, token_hash, expires_at)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 RETURNING id, org_id, email, role, invited_by, expires_at, created_at, accepted_at, revoked_at`,
		orgID, email, role, invitedBy, tokenHash, expiresAt,
	).Scan(&invitation.ID, &invitation.OrgID, &invitation.Email, &invitation.Role,
		&invitation.InvitedBy, &invitation.ExpiresAt, &invitation.CreatedAt,
		&invitation.AcceptedAt, &invitation.RevokedAt)
	if err != nil {
		return nil, fmt.Errorf("create invitation: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit invitation create: %w", err)
	}
	return &invitation, nil
}

func (q *Queries) ListInvitationsByOrg(ctx context.Context, orgID string) ([]Invitation, error) {
	rows, err := q.pool.Query(ctx,
		`SELECT id, org_id, email, role, invited_by, expires_at, created_at, accepted_at, revoked_at
		 FROM org_invitations WHERE org_id = $1 ORDER BY created_at DESC`, orgID)
	if err != nil {
		return nil, fmt.Errorf("list invitations: %w", err)
	}
	defer rows.Close()
	result := make([]Invitation, 0)
	for rows.Next() {
		var invitation Invitation
		if err := rows.Scan(&invitation.ID, &invitation.OrgID, &invitation.Email, &invitation.Role,
			&invitation.InvitedBy, &invitation.ExpiresAt, &invitation.CreatedAt,
			&invitation.AcceptedAt, &invitation.RevokedAt); err != nil {
			return nil, fmt.Errorf("scan invitation: %w", err)
		}
		result = append(result, invitation)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list invitations: %w", err)
	}
	return result, nil
}

func (q *Queries) RevokeInvitation(ctx context.Context, orgID, invitationID string) error {
	ct, err := q.pool.Exec(ctx,
		`UPDATE org_invitations SET revoked_at = now()
		 WHERE id = $1 AND org_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
		invitationID, orgID)
	if err != nil {
		return fmt.Errorf("revoke invitation: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return ErrInvalidInvitation
	}
	return nil
}

// AcceptInvitation atomically validates the invite against a verified provider
// identity for the accepting user, consumes it, and creates the membership.
func (q *Queries) AcceptInvitation(ctx context.Context, tokenHash, userID string) (string, error) {
	tx, err := q.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return "", fmt.Errorf("begin invitation acceptance: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var orgID, role string
	err = tx.QueryRow(ctx,
		`UPDATE org_invitations i SET accepted_at = now()
		 WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL
		   AND i.expires_at > now()
		   AND EXISTS (
		     SELECT 1 FROM users u
		     JOIN auth_identities ai ON ai.user_id = u.id
		     WHERE u.id = $2 AND ai.email_verified
		       AND lower(ai.provider_email) = lower(i.email)
		       AND lower(u.email) = lower(i.email)
		   )
		 RETURNING i.org_id, i.role`, tokenHash, userID).Scan(&orgID, &role)
	if err == pgx.ErrNoRows {
		return "", ErrInvalidInvitation
	}
	if err != nil {
		return "", fmt.Errorf("consume invitation: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO memberships (user_id, org_id, role) VALUES ($1, $2, $3)
		 ON CONFLICT (user_id, org_id) DO NOTHING`, userID, orgID, role); err != nil {
		return "", fmt.Errorf("create invited membership: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("commit invitation acceptance: %w", err)
	}
	return orgID, nil
}

type CLIPKCERequest struct {
	ClientID            string
	RedirectURI         string
	OAuthState          string
	CodeChallenge       string
	CodeChallengeMethod string
}

const MaxOAuthVerificationAttempts = 5

// OAuthVerificationContinuation is the self-contained server-side snapshot
// needed to resume either a browser or CLI OAuth flow after email verification.
type OAuthVerificationContinuation struct {
	PendingTokenSealed     []byte
	FlowKind               string
	TargetOrgID            string
	CLIClientID            string
	CLIRedirectURI         string
	CLIOAuthState          string
	CLICodeChallenge       string
	CLICodeChallengeMethod string
	Attempts               int
}

func (q *Queries) StoreOAuthVerificationContinuation(ctx context.Context, flowHash string, continuation OAuthVerificationContinuation, expiresAt time.Time) error {
	_, err := q.pool.Exec(ctx,
		`INSERT INTO oauth_verification_continuations
		 (flow_hash, pending_token_sealed, flow_kind, target_org_id,
		  cli_client_id, cli_redirect_uri, cli_oauth_state,
		  cli_code_challenge, cli_code_challenge_method, expires_at)
		 VALUES ($1, $2, $3, NULLIF($4, '')::uuid,
		         NULLIF($5, ''), NULLIF($6, ''), NULLIF($7, ''),
		         NULLIF($8, ''), NULLIF($9, ''), $10)`,
		flowHash, continuation.PendingTokenSealed, continuation.FlowKind,
		continuation.TargetOrgID, continuation.CLIClientID,
		continuation.CLIRedirectURI, continuation.CLIOAuthState,
		continuation.CLICodeChallenge, continuation.CLICodeChallengeMethod,
		expiresAt,
	)
	if err != nil {
		return fmt.Errorf("store OAuth verification continuation: %w", err)
	}
	return nil
}

// ReserveOAuthVerificationAttempt atomically claims the next bounded attempt
// and returns its payload. Nil means the flow is missing, expired, consumed, or
// has exhausted its attempt budget.
func (q *Queries) ReserveOAuthVerificationAttempt(ctx context.Context, flowHash string) (*OAuthVerificationContinuation, error) {
	var continuation OAuthVerificationContinuation
	err := q.pool.QueryRow(ctx,
		`UPDATE oauth_verification_continuations
		    SET attempts = attempts + 1
		  WHERE flow_hash = $1
		    AND consumed_at IS NULL
		    AND expires_at > now()
		    AND attempts < $2
		RETURNING pending_token_sealed, flow_kind,
		          COALESCE(target_org_id::text, ''),
		          COALESCE(cli_client_id, ''), COALESCE(cli_redirect_uri, ''),
		          COALESCE(cli_oauth_state, ''), COALESCE(cli_code_challenge, ''),
		          COALESCE(cli_code_challenge_method, ''), attempts`,
		flowHash, MaxOAuthVerificationAttempts,
	).Scan(&continuation.PendingTokenSealed, &continuation.FlowKind,
		&continuation.TargetOrgID, &continuation.CLIClientID,
		&continuation.CLIRedirectURI, &continuation.CLIOAuthState,
		&continuation.CLICodeChallenge, &continuation.CLICodeChallengeMethod,
		&continuation.Attempts)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("reserve OAuth verification attempt: %w", err)
	}
	return &continuation, nil
}

// ConsumeOAuthVerificationContinuation is a compare-and-set completion gate.
// Exactly one concurrent caller can win; false means the flow was already used.
func (q *Queries) ConsumeOAuthVerificationContinuation(ctx context.Context, flowHash string) (bool, error) {
	var id string
	err := q.pool.QueryRow(ctx,
		`UPDATE oauth_verification_continuations SET consumed_at = now()
		 WHERE flow_hash = $1 AND consumed_at IS NULL
		 RETURNING id`, flowHash,
	).Scan(&id)
	if err == pgx.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("consume OAuth verification continuation: %w", err)
	}
	return true, nil
}

func (q *Queries) StoreOAuthLoginState(ctx context.Context, stateHash string, expiresAt time.Time) error {
	return q.StoreOAuthLoginStateForOrg(ctx, stateHash, "", "", expiresAt)
}

// StoreOAuthLoginStateForOrg binds an optional active organization to the
// single-use state. The callback revalidates membership before using it.
func (q *Queries) StoreOAuthLoginStateForOrg(ctx context.Context, stateHash, targetOrgID, initiatingUserID string, expiresAt time.Time) error {
	_, err := q.pool.Exec(ctx,
		`INSERT INTO oauth_login_states (state_hash, target_org_id, initiating_user_id, expires_at)
		 VALUES ($1, NULLIF($2, '')::uuid, NULLIF($3, '')::uuid, $4)`,
		stateHash, targetOrgID, initiatingUserID, expiresAt)
	if err != nil {
		return fmt.Errorf("store OAuth login state: %w", err)
	}
	return nil
}

func (q *Queries) ConsumeOAuthLoginState(ctx context.Context, stateHash string) (bool, error) {
	state, err := q.ConsumeOAuthLoginStateDetails(ctx, stateHash)
	return state != nil, err
}

type OAuthLoginState struct {
	TargetOrgID      *string
	InitiatingUserID *string
	ReservationToken string
}

// GetOAuthLoginStateDetails reads callback context without reserving or
// consuming it. The actor and organization bindings are immutable.
func (q *Queries) GetOAuthLoginStateDetails(ctx context.Context, stateHash string) (*OAuthLoginState, error) {
	var state OAuthLoginState
	err := q.pool.QueryRow(ctx,
		`SELECT target_org_id, initiating_user_id
		 FROM oauth_login_states
		 WHERE state_hash = $1 AND consumed_at IS NULL AND expires_at > now()`,
		stateHash).Scan(&state.TargetOrgID, &state.InitiatingUserID)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get OAuth login state: %w", err)
	}
	return &state, nil
}

// ReserveOAuthLoginState leases a valid state for two minutes. A new UUID
// token prevents a stale callback from finalizing or releasing a newer lease.
func (q *Queries) ReserveOAuthLoginState(ctx context.Context, stateHash string) (*OAuthLoginState, error) {
	var state OAuthLoginState
	err := q.pool.QueryRow(ctx,
		`UPDATE oauth_login_states
		 SET reserved_at = now(), reservation_token = gen_random_uuid()
		 WHERE state_hash = $1
		   AND consumed_at IS NULL
		   AND expires_at > now()
		   AND (reserved_at IS NULL OR reserved_at <= now() - interval '2 minutes')
		 RETURNING target_org_id, initiating_user_id, reservation_token::text`,
		stateHash).Scan(&state.TargetOrgID, &state.InitiatingUserID, &state.ReservationToken)
	if err == nil {
		return &state, nil
	}
	if err != pgx.ErrNoRows {
		return nil, fmt.Errorf("reserve OAuth login state: %w", err)
	}
	var inFlight bool
	err = q.pool.QueryRow(ctx,
		`SELECT reserved_at IS NOT NULL AND reserved_at > now() - interval '2 minutes'
		 FROM oauth_login_states
		 WHERE state_hash = $1 AND consumed_at IS NULL AND expires_at > now()`,
		stateHash).Scan(&inFlight)
	if err == nil && inFlight {
		return nil, ErrOAuthLoginStateInFlight
	}
	if err != nil && err != pgx.ErrNoRows {
		return nil, fmt.Errorf("inspect OAuth login state reservation: %w", err)
	}
	return nil, nil
}

// FinalizeOAuthLoginState consumes a state only when the caller still owns an
// unexpired reservation. It accepts the transaction that persists the install.
func (q *Queries) FinalizeOAuthLoginState(ctx context.Context, tx pgx.Tx, stateHash, reservationToken string) error {
	tag, err := tx.Exec(ctx,
		`UPDATE oauth_login_states
		 SET consumed_at = now(), reserved_at = NULL, reservation_token = NULL
		 WHERE state_hash = $1
		   AND reservation_token = $2::uuid
		   AND reserved_at > now() - interval '2 minutes'
		   AND consumed_at IS NULL
		   AND expires_at > now()`, stateHash, reservationToken)
	if err != nil {
		return fmt.Errorf("finalize OAuth login state: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return ErrOAuthLoginStateReservation
	}
	return nil
}

// ReleaseOAuthLoginState releases only the lease owned by reservationToken.
func (q *Queries) ReleaseOAuthLoginState(ctx context.Context, stateHash, reservationToken string) error {
	tag, err := q.pool.Exec(ctx,
		`UPDATE oauth_login_states
		 SET reserved_at = NULL, reservation_token = NULL
		 WHERE state_hash = $1 AND reservation_token = $2::uuid AND consumed_at IS NULL`,
		stateHash, reservationToken)
	if err != nil {
		return fmt.Errorf("release OAuth login state: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return ErrOAuthLoginStateReservation
	}
	return nil
}

// ConsumeOAuthLoginStateDetails atomically consumes a state and returns its
// server-bound callback context. Nil means missing, expired, or already used.
func (q *Queries) ConsumeOAuthLoginStateDetails(ctx context.Context, stateHash string) (*OAuthLoginState, error) {
	var state OAuthLoginState
	err := q.pool.QueryRow(ctx,
		`UPDATE oauth_login_states SET consumed_at = now()
		 WHERE state_hash = $1 AND consumed_at IS NULL AND expires_at > now()
		 RETURNING target_org_id, initiating_user_id`, stateHash).
		Scan(&state.TargetOrgID, &state.InitiatingUserID)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("consume OAuth login state: %w", err)
	}
	return &state, nil
}

func (q *Queries) StoreCLIPKCERequest(ctx context.Context, stateHash string, request CLIPKCERequest, expiresAt time.Time) error {
	_, err := q.pool.Exec(ctx,
		`INSERT INTO cli_pkce_requests
		 (state_hash, client_id, redirect_uri, oauth_state, code_challenge, code_challenge_method, expires_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)`, stateHash, request.ClientID,
		request.RedirectURI, request.OAuthState, request.CodeChallenge, request.CodeChallengeMethod, expiresAt)
	if err != nil {
		return fmt.Errorf("store CLI PKCE request: %w", err)
	}
	return nil
}

func (q *Queries) ConsumeCLIPKCERequest(ctx context.Context, stateHash string) (*CLIPKCERequest, error) {
	var request CLIPKCERequest
	err := q.pool.QueryRow(ctx,
		`UPDATE cli_pkce_requests SET consumed_at = now()
		 WHERE state_hash = $1 AND consumed_at IS NULL AND expires_at > now()
		 RETURNING client_id, redirect_uri, oauth_state, code_challenge, code_challenge_method`, stateHash,
	).Scan(&request.ClientID, &request.RedirectURI, &request.OAuthState,
		&request.CodeChallenge, &request.CodeChallengeMethod)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("consume CLI PKCE request: %w", err)
	}
	return &request, nil
}

// === Refresh Tokens ===

// StoreRefreshToken inserts a hashed refresh token for a user with a family ID
// for rotation reuse detection.
func (q *Queries) StoreRefreshToken(ctx context.Context, userID, tokenHash, familyID, orgID string, expiresAt time.Time) error {
	_, err := q.pool.Exec(ctx,
		`INSERT INTO refresh_tokens (user_id, token_hash, family_id, org_id, expires_at)
		 VALUES ($1, $2, $3, NULLIF($4, '')::uuid, $5)`,
		userID, tokenHash, familyID, orgID, expiresAt,
	)
	if err != nil {
		return fmt.Errorf("store refresh token: %w", err)
	}
	return nil
}

// ConsumeRefreshToken atomically marks a refresh token as used (soft-delete via revoked_at)
// and returns the user_id and family_id for issuing a replacement.
//
// If the token was already revoked, this indicates token reuse (theft).
// In that case, ALL tokens in the family are revoked and ErrTokenReuse is returned.
//
// Returns ("", "", "", nil) if the token is not found or expired.
func (q *Queries) ConsumeRefreshToken(ctx context.Context, tokenHash string) (userID, familyID, orgID string, err error) {
	// Atomic consume: UPDATE ... RETURNING ensures only one concurrent caller wins.
	err = q.pool.QueryRow(ctx,
		`UPDATE refresh_tokens SET revoked_at = now()
		 WHERE token_hash = $1 AND expires_at > now() AND revoked_at IS NULL
		 RETURNING user_id, family_id, COALESCE(org_id::text, '')`,
		tokenHash,
	).Scan(&userID, &familyID, &orgID)

	if err == pgx.ErrNoRows {
		// Token not found, expired, or already revoked.
		// Check if it was a previously-revoked token (reuse detection).
		// Grace period: ignore tokens revoked in the last 5 seconds to avoid
		// a race where a concurrent legitimate refresh triggers false reuse.
		var fID string
		err2 := q.pool.QueryRow(ctx,
			`SELECT family_id FROM refresh_tokens
			 WHERE token_hash = $1 AND revoked_at IS NOT NULL
			 AND revoked_at < now() - INTERVAL '5 seconds'`,
			tokenHash,
		).Scan(&fID)
		if err2 == nil {
			// Reuse detected — revoke entire family
			if _, rErr := q.pool.Exec(ctx,
				`UPDATE refresh_tokens SET revoked_at = now()
				 WHERE family_id = $1 AND revoked_at IS NULL`,
				fID,
			); rErr != nil {
				slog.Error("failed to revoke token family on reuse detection",
					"family_id", fID, "error", rErr)
			}
			return "", "", "", ErrTokenReuse
		}
		return "", "", "", nil
	}
	if err != nil {
		return "", "", "", fmt.Errorf("consume refresh token: %w", err)
	}
	return userID, familyID, orgID, nil
}

// RevokeAllUserRefreshTokens revokes all active refresh tokens for a user (logout).
func (q *Queries) RevokeAllUserRefreshTokens(ctx context.Context, userID string) (int64, error) {
	ct, err := q.pool.Exec(ctx,
		`UPDATE refresh_tokens SET revoked_at = now()
		 WHERE user_id = $1 AND revoked_at IS NULL`,
		userID,
	)
	if err != nil {
		return 0, fmt.Errorf("revoke all user refresh tokens: %w", err)
	}
	return ct.RowsAffected(), nil
}

// CleanupExpiredTokens removes expired/revoked refresh tokens and auth codes
// older than 1 day. Returns counts of deleted rows.
func (q *Queries) CleanupExpiredTokens(ctx context.Context) (int64, int64, error) {
	ct1, err := q.pool.Exec(ctx,
		`DELETE FROM refresh_tokens
		 WHERE (revoked_at IS NOT NULL AND revoked_at < now() - INTERVAL '1 day')
		    OR (expires_at < now() - INTERVAL '1 day')`)
	if err != nil {
		return 0, 0, fmt.Errorf("cleanup refresh tokens: %w", err)
	}
	ct2, err := q.pool.Exec(ctx,
		`DELETE FROM oauth_authorization_codes WHERE expires_at < now() - INTERVAL '1 day'`)
	if err != nil {
		return ct1.RowsAffected(), 0, fmt.Errorf("cleanup auth codes: %w", err)
	}
	if _, err := q.pool.Exec(ctx,
		`DELETE FROM cli_pkce_requests
		 WHERE expires_at < now() - INTERVAL '1 day'
		    OR consumed_at < now() - INTERVAL '1 day'`); err != nil {
		return ct1.RowsAffected(), ct2.RowsAffected(), fmt.Errorf("cleanup CLI PKCE requests: %w", err)
	}
	if _, err := q.pool.Exec(ctx,
		`DELETE FROM oauth_login_states
		 WHERE expires_at < now() - INTERVAL '1 day'
		    OR consumed_at < now() - INTERVAL '1 day'`); err != nil {
		return ct1.RowsAffected(), ct2.RowsAffected(), fmt.Errorf("cleanup OAuth login states: %w", err)
	}
	if _, err := q.pool.Exec(ctx,
		`DELETE FROM oauth_verification_continuations
		 WHERE expires_at < now() - INTERVAL '1 day'
		    OR consumed_at < now() - INTERVAL '1 day'`); err != nil {
		return ct1.RowsAffected(), ct2.RowsAffected(), fmt.Errorf("cleanup OAuth verification continuations: %w", err)
	}
	return ct1.RowsAffected(), ct2.RowsAffected(), nil
}

// === OAuth Authorization Codes ===

type AuthCodeResult struct {
	UserID              string
	CodeChallenge       string
	CodeChallengeMethod string
	RedirectURI         string
	ClientID            string
}

// StoreAuthorizationCode inserts a hashed authorization code.
func (q *Queries) StoreAuthorizationCode(ctx context.Context, userID, codeHash, codeChallenge, codeChallengeMethod, redirectURI, clientID string, expiresAt time.Time) error {
	_, err := q.pool.Exec(ctx,
		`INSERT INTO oauth_authorization_codes (user_id, code_hash, code_challenge, code_challenge_method, redirect_uri, client_id, expires_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		userID, codeHash, codeChallenge, codeChallengeMethod, redirectURI, clientID, expiresAt,
	)
	if err != nil {
		return fmt.Errorf("store authorization code: %w", err)
	}
	return nil
}

// ConsumeAuthorizationCode atomically marks an auth code as used and returns
// the associated data. Returns nil if code not found, already used, or expired.
func (q *Queries) ConsumeAuthorizationCode(ctx context.Context, codeHash string) (*AuthCodeResult, error) {
	var result AuthCodeResult
	err := q.pool.QueryRow(ctx,
		`UPDATE oauth_authorization_codes
		 SET used_at = now()
		 WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()
		 RETURNING user_id, code_challenge, code_challenge_method, redirect_uri, client_id`,
		codeHash,
	).Scan(&result.UserID, &result.CodeChallenge, &result.CodeChallengeMethod, &result.RedirectURI, &result.ClientID)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("consume authorization code: %w", err)
	}
	return &result, nil
}

// === Project lookup (org-scoped tenant check) ===

// ListProjectsByOrg returns all projects for a given org. Tenant-scoped.
func (q *Queries) ListProjectsByOrg(ctx context.Context, orgID string) ([]Project, error) {
	rows, err := q.pool.Query(ctx,
		`SELECT id, org_id, name, github_repo, default_branch, friction_autonomy, pr_posture, default_environment_id, digest_timezone, created_at
		 FROM projects
		 WHERE org_id = $1
		 ORDER BY created_at ASC`,
		orgID,
	)
	if err != nil {
		return nil, fmt.Errorf("list projects by org: %w", err)
	}
	defer rows.Close()

	var projects []Project
	for rows.Next() {
		var p Project
		if err := rows.Scan(&p.ID, &p.OrgID, &p.Name, &p.GithubRepo, &p.DefaultBranch, &p.FrictionAutonomy, &p.PrPosture, &p.DefaultEnvironmentID, &p.DigestTimezone, &p.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan project: %w", err)
		}
		projects = append(projects, p)
	}
	return projects, rows.Err()
}

// GetProjectByOrgID returns a project by ID within the given org. Returns nil if not found
// or if the project belongs to a different org (tenant-scoped).
func (q *Queries) GetProjectByOrgID(ctx context.Context, orgID, projectID string) (*Project, error) {
	var p Project
	err := q.pool.QueryRow(ctx,
		`SELECT id, org_id, name, github_repo, default_branch, friction_autonomy, pr_posture, default_environment_id, digest_timezone, created_at
		 FROM projects WHERE id = $1 AND org_id = $2`,
		projectID, orgID,
	).Scan(&p.ID, &p.OrgID, &p.Name, &p.GithubRepo, &p.DefaultBranch, &p.FrictionAutonomy, &p.PrPosture, &p.DefaultEnvironmentID, &p.DigestTimezone, &p.CreatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get project by id: %w", err)
	}
	return &p, nil
}

type projectQueryRower interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func updateProject(
	ctx context.Context,
	queryer projectQueryRower,
	orgID, projectID string,
	githubRepo, frictionAutonomy, prPosture, defaultEnvironmentID, digestTimezone *string,
) (*Project, error) {
	var p Project
	query := `UPDATE projects
		 SET github_repo = COALESCE($3, github_repo),
		     friction_autonomy = COALESCE($4, friction_autonomy),
		     pr_posture = COALESCE($5, pr_posture),
		     digest_timezone = COALESCE($6, digest_timezone)
		 WHERE id = $2 AND org_id = $1
		 RETURNING id, org_id, name, github_repo, default_branch, friction_autonomy, pr_posture, default_environment_id, digest_timezone, created_at`
	args := []any{orgID, projectID, githubRepo, frictionAutonomy, prPosture, digestTimezone}
	if defaultEnvironmentID != nil {
		query = `UPDATE projects p
		 SET github_repo = COALESCE($3, p.github_repo),
		     friction_autonomy = COALESCE($4, p.friction_autonomy),
		     pr_posture = COALESCE($5, p.pr_posture),
		     digest_timezone = COALESCE($6, p.digest_timezone),
		     default_environment_id = e.id
		 FROM environments e
		 WHERE p.id = $2 AND p.org_id = $1
		   AND e.id = $7 AND e.project_id = p.id
		 RETURNING p.id, p.org_id, p.name, p.github_repo, p.default_branch, p.friction_autonomy, p.pr_posture, p.default_environment_id, p.digest_timezone, p.created_at`
		args = append(args, *defaultEnvironmentID)
	}
	err := queryer.QueryRow(ctx, query, args...).Scan(&p.ID, &p.OrgID, &p.Name, &p.GithubRepo, &p.DefaultBranch, &p.FrictionAutonomy, &p.PrPosture, &p.DefaultEnvironmentID, &p.DigestTimezone, &p.CreatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("update project: %w", err)
	}
	return &p, nil
}

// UpdateProject updates a project's settings. Only non-nil fields are changed.
// Tenant-scoped by orgID.
func (q *Queries) UpdateProject(ctx context.Context, orgID, projectID string, githubRepo, frictionAutonomy, prPosture, defaultEnvironmentID, digestTimezone *string) (*Project, error) {
	return updateProject(ctx, q.pool, orgID, projectID, githubRepo, frictionAutonomy, prPosture, defaultEnvironmentID, digestTimezone)
}

// UpdateProjectTx is UpdateProject on a caller-owned transaction, used when a
// settings PATCH must atomically update multiple project-owned settings.
func UpdateProjectTx(ctx context.Context, tx pgx.Tx, orgID, projectID string, githubRepo, frictionAutonomy, prPosture, defaultEnvironmentID, digestTimezone *string) (*Project, error) {
	return updateProject(ctx, tx, orgID, projectID, githubRepo, frictionAutonomy, prPosture, defaultEnvironmentID, digestTimezone)
}

// FixStats are the receipts shown beside each autonomy option.
type FixStats struct {
	GeneratedAuto  int `json:"generated_auto"`
	GeneratedHuman int `json:"generated_human"`
	PRsMerged      int `json:"prs_merged"`
	PRsClosed      int `json:"prs_closed"`
	// Auto-only outcome splits, attributed via pr_outcomes.fix_job_id →
	// error_group_jobs.triggered_by, so the auto-fix receipt line never counts
	// human-requested PRs. Receipts without a fix_job_id (pre-receipts PRs)
	// count only in the totals above.
	PRsMergedAuto int `json:"prs_merged_auto"`
	PRsClosedAuto int `json:"prs_closed_auto"`
}

// GetFixStats aggregates fix generation and PR outcomes per incident kind.
// The project ID scopes both source queries to a single tenant project.
func (q *Queries) GetFixStats(ctx context.Context, projectID string) (map[string]FixStats, error) {
	stats := map[string]FixStats{
		"error":    {},
		"friction": {},
	}

	rows, err := q.pool.Query(ctx,
		`SELECT eg.kind, j.triggered_by, count(*)
		 FROM error_group_jobs j
		 JOIN error_groups eg ON j.error_group_id = eg.id
		 WHERE j.project_id = $1
		   AND j.job_type IN ('fix', 'error_fix')
		   AND j.triggered_by IS NOT NULL
		 GROUP BY eg.kind, j.triggered_by`,
		projectID,
	)
	if err != nil {
		return nil, fmt.Errorf("get fix stats jobs: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var kind, triggeredBy string
		var count int
		if err := rows.Scan(&kind, &triggeredBy, &count); err != nil {
			return nil, fmt.Errorf("scan fix stats jobs: %w", err)
		}
		stat := stats[kind]
		switch triggeredBy {
		case "human":
			stat.GeneratedHuman = count
		case "auto":
			stat.GeneratedAuto = count
		}
		stats[kind] = stat
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate fix stats jobs: %w", err)
	}

	outcomeRows, err := q.pool.Query(ctx,
		`SELECT eg.kind, o.outcome, COALESCE(j.triggered_by, '') AS triggered_by, count(*)
		 FROM pr_outcomes o
		 JOIN error_groups eg ON o.error_group_id = eg.id
		 LEFT JOIN error_group_jobs j ON o.fix_job_id = j.id
		 WHERE o.project_id = $1
		 GROUP BY eg.kind, o.outcome, COALESCE(j.triggered_by, '')`,
		projectID,
	)
	if err != nil {
		return nil, fmt.Errorf("get fix stats outcomes: %w", err)
	}
	defer outcomeRows.Close()
	for outcomeRows.Next() {
		var kind, outcome, triggeredBy string
		var count int
		if err := outcomeRows.Scan(&kind, &outcome, &triggeredBy, &count); err != nil {
			return nil, fmt.Errorf("scan fix stats outcomes: %w", err)
		}
		stat := stats[kind]
		switch outcome {
		case "merged":
			stat.PRsMerged += count
			if triggeredBy == "auto" {
				stat.PRsMergedAuto += count
			}
		case "closed":
			stat.PRsClosed += count
			if triggeredBy == "auto" {
				stat.PRsClosedAuto += count
			}
		}
		stats[kind] = stat
	}
	if err := outcomeRows.Err(); err != nil {
		return nil, fmt.Errorf("iterate fix stats outcomes: %w", err)
	}

	return stats, nil
}

// ListEnvironments returns project environments, optionally restricted to the
// telemetry surface that has observed them. Tenant-scoped.
func (q *Queries) ListEnvironments(ctx context.Context, projectID, usedBy string) ([]Environment, error) {
	var query string
	switch usedBy {
	case "":
		query = `SELECT e.id, e.project_id, e.name, e.created_at
		 FROM environments e
		 WHERE e.project_id = $1
		 ORDER BY e.created_at, e.id`
	case "incidents":
		query = `SELECT e.id, e.project_id, e.name, e.created_at
		 FROM environments e
		 WHERE e.project_id = $1
		   AND (
		     EXISTS (
		       SELECT 1
		       FROM error_group_environments ege
		       JOIN error_groups eg ON eg.id = ege.error_group_id
		       WHERE ege.environment_id = e.id
		         AND eg.project_id = e.project_id
		         AND eg.kind = 'error'
		     )
		     OR EXISTS (
		       SELECT 1 FROM error_groups eg
		       WHERE eg.project_id = e.project_id
		         AND eg.kind = 'friction'
		         AND eg.environment_id = e.id
		     )
		   )
		 ORDER BY e.created_at, e.id`
	case "sessions":
		query = `SELECT e.id, e.project_id, e.name, e.created_at
		 FROM environments e
		 WHERE e.project_id = $1
		   AND EXISTS (
		     SELECT 1 FROM sessions s
		     WHERE s.project_id = e.project_id
		       AND s.environment_id = e.id
		       AND s.status <> 'deleting'
		   )
		 ORDER BY e.created_at, e.id`
	default:
		return nil, fmt.Errorf("unknown environment usage %q", usedBy)
	}
	rows, err := q.pool.Query(ctx, query, projectID)
	if err != nil {
		return nil, fmt.Errorf("list environments: %w", err)
	}
	defer rows.Close()

	var envs []Environment
	for rows.Next() {
		var e Environment
		if err := rows.Scan(&e.ID, &e.ProjectID, &e.Name, &e.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan environment: %w", err)
		}
		envs = append(envs, e)
	}
	return envs, rows.Err()
}

// HasEvents checks if a project has any error events. Uses EXISTS for performance.
func (q *Queries) HasEvents(ctx context.Context, projectID string) (bool, error) {
	var exists bool
	err := q.pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM error_events WHERE project_id = $1)`,
		projectID,
	).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("has events: %w", err)
	}
	return exists, nil
}

// LatestErrorGroupID returns the most recently active error group, or nil.
func (q *Queries) LatestErrorGroupID(ctx context.Context, projectID string) (*string, error) {
	var id string
	err := q.pool.QueryRow(ctx,
		`SELECT id::text FROM error_groups WHERE project_id = $1 ORDER BY last_seen DESC, id DESC LIMIT 1`,
		projectID,
	).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("latest error group: %w", err)
	}
	return &id, nil
}

// OrgOnboarded reports the stored wizard completion fact for an org.
func (q *Queries) OrgOnboarded(ctx context.Context, orgID string) (bool, error) {
	var onboardedAt *time.Time
	if err := q.pool.QueryRow(ctx,
		`SELECT onboarded_at FROM orgs WHERE id = $1`, orgID,
	).Scan(&onboardedAt); err != nil {
		return false, fmt.Errorf("org onboarded: %w", err)
	}
	return onboardedAt != nil, nil
}

// NewestProjectIDAndRepo returns the newest project and its attached repo.
func (q *Queries) NewestProjectIDAndRepo(ctx context.Context, orgID string) (*string, *string, error) {
	var id string
	var repo *string
	err := q.pool.QueryRow(ctx, `
		SELECT id::text, github_repo
		FROM projects
		WHERE org_id = $1
		ORDER BY created_at DESC, id DESC
		LIMIT 1`, orgID,
	).Scan(&id, &repo)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, fmt.Errorf("newest project: %w", err)
	}
	return &id, repo, nil
}

// HasEnabledDigestDestination reports whether a project has a live daily digest destination.
func (q *Queries) HasEnabledDigestDestination(ctx context.Context, projectID string) (bool, error) {
	var exists bool
	err := q.pool.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1
			FROM notification_destinations
			WHERE project_id = $1
			  AND enabled
			  AND 'digest.daily' = ANY(event_types)
		)`, projectID,
	).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("has digest destination: %w", err)
	}
	return exists, nil
}

// MarkOrgOnboarded records completion once; replays are no-ops.
func (q *Queries) MarkOrgOnboarded(ctx context.Context, orgID string) error {
	if _, err := q.pool.Exec(ctx,
		`UPDATE orgs SET onboarded_at = now() WHERE id = $1 AND onboarded_at IS NULL`, orgID,
	); err != nil {
		return fmt.Errorf("mark onboarded: %w", err)
	}
	return nil
}

// VerifyEnvironmentAccess checks that an environment belongs to the given org.
// Returns the project_id if the environment is owned, empty string if not found.
func (q *Queries) VerifyEnvironmentAccess(ctx context.Context, orgID, envID string) (string, error) {
	var projectID string
	err := q.pool.QueryRow(ctx,
		`SELECT e.project_id FROM environments e
		 JOIN projects p ON p.id = e.project_id
		 WHERE e.id = $1 AND p.org_id = $2`,
		envID, orgID,
	).Scan(&projectID)
	if err == pgx.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("verify environment access: %w", err)
	}
	return projectID, nil
}

// === Transaction variants for composite operations ===

// CreateProjectTx creates a project within an existing transaction.
func (q *Queries) CreateProjectTx(ctx context.Context, tx pgx.Tx, orgID, name string, githubRepo *string) (*Project, error) {
	var p Project
	err := tx.QueryRow(ctx,
		`INSERT INTO projects (org_id, name, github_repo)
		 VALUES ($1, $2, $3)
		 RETURNING id, org_id, name, github_repo, default_branch, friction_autonomy, pr_posture, default_environment_id, digest_timezone, created_at`,
		orgID, name, githubRepo,
	).Scan(&p.ID, &p.OrgID, &p.Name, &p.GithubRepo, &p.DefaultBranch, &p.FrictionAutonomy, &p.PrPosture, &p.DefaultEnvironmentID, &p.DigestTimezone, &p.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("create project tx: %w", err)
	}
	// Creating a project with a usable repository is the same transition a
	// later connect makes; schedule repository understanding once here.
	if githubRepo != nil && strings.TrimSpace(*githubRepo) != "" {
		if err := enqueueProductContextConnectTx(ctx, tx, p.ID); err != nil {
			return nil, fmt.Errorf("create project tx: %w", err)
		}
	}
	return &p, nil
}

// === GitHub config CRUD ===

// enqueueProductContextConnectTx schedules repository understanding when a
// project gains or switches its repo. A repo switch must supersede active
// work exactly like a newer push does: a worker still cloning the OLD repo
// is fenced by lease_generation, and this reset guarantees a fresh job runs
// against the new repo. Mirrors EnqueueProductContextPush's conflict arm.
func enqueueProductContextConnectTx(ctx context.Context, tx pgx.Tx, projectID string) error {
	_, err := tx.Exec(ctx,
		`INSERT INTO error_group_jobs (project_id, job_type, triggered_by, payload)
		 VALUES ($1, 'product_context', 'auto', '{"trigger":"connect"}'::jsonb)
		 ON CONFLICT (project_id, job_type)
		   WHERE job_type = 'product_context' AND status IN ('pending','claimed')
		 DO UPDATE SET
		   status = 'pending',
		   worker_id = NULL,
		   claimed_at = NULL,
		   lease_expires_at = NULL,
		   available_at = now(),
		   attempts = 0,
		   last_error = NULL,
		   payload = EXCLUDED.payload,
		   updated_at = now()`,
		projectID,
	)
	if err != nil {
		return fmt.Errorf("enqueue product context on connect: %w", err)
	}
	return nil
}

// SetProjectGitHubConfig stores the GitHub repo and its resolved default branch.
// Tenant-scoped by orgID. Gaining or switching a usable repository enqueues
// repository understanding; re-saving the same repo is not a transition.
func (q *Queries) SetProjectGitHubConfig(
	ctx context.Context,
	orgID, projectID, githubRepo, defaultBranch string,
) error {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("set project github config: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Read-then-write as two ordered statements under a row lock: sibling CTEs
	// have no guaranteed execution order, so the previous value must be read
	// before the update runs.
	var previous *string
	err = tx.QueryRow(ctx,
		`SELECT github_repo FROM projects WHERE id = $2 AND org_id = $1 FOR UPDATE`,
		orgID, projectID,
	).Scan(&previous)
	if err == pgx.ErrNoRows {
		return fmt.Errorf("set project github config: no matching project %s in org %s", projectID, orgID)
	}
	if err != nil {
		return fmt.Errorf("set project github config: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE projects SET github_repo = $3, default_branch = $4
		 WHERE id = $2 AND org_id = $1`,
		orgID, projectID, githubRepo, defaultBranch,
	); err != nil {
		return fmt.Errorf("set project github config: %w", err)
	}

	next := strings.TrimSpace(githubRepo)
	if next != "" && (previous == nil || strings.TrimSpace(*previous) != next) {
		if err := enqueueProductContextConnectTx(ctx, tx, projectID); err != nil {
			return fmt.Errorf("set project github config: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("set project github config: commit: %w", err)
	}
	return nil
}

// ClearProjectGitHubConfig clears the GitHub repo association for a project. Tenant-scoped by orgID.
func (q *Queries) ClearProjectGitHubConfig(ctx context.Context, orgID, projectID string) error {
	ct, err := q.pool.Exec(ctx,
		`UPDATE projects SET github_repo = NULL
		 WHERE id = $2 AND org_id = $1`,
		orgID, projectID,
	)
	if err != nil {
		return fmt.Errorf("clear project github config: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return fmt.Errorf("clear project github config: no matching project %s in org %s", projectID, orgID)
	}
	return nil
}

// GetProjectGitHubConfig returns the GitHub repo for a project. Tenant-scoped by orgID.
func (q *Queries) GetProjectGitHubConfig(ctx context.Context, orgID, projectID string) (githubRepo *string, err error) {
	err = q.pool.QueryRow(ctx,
		`SELECT github_repo FROM projects WHERE id = $1 AND org_id = $2`,
		projectID, orgID,
	).Scan(&githubRepo)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get project github config: %w", err)
	}
	return githubRepo, nil
}

// === Agent sessions ===

// AgentSession represents a CLI-initiated auth session for agent-first onboarding.
type AgentSession struct {
	ID             string
	RepoURL        string
	AgentName      *string
	Status         string // pending | provisioned | key_ok | app_reporting | completed | expired | failed
	OrgID          *string
	ProjectID      *string
	InstallationID *int64
	PollTokenHash  *string
	AgentKeyPub    *string
	APIKeySealed   *string
	FailureReason  *string
	AuthClickedAt  *time.Time
	KeyClaimedAt   *time.Time
	CreatedAt      time.Time
	CompletedAt    *time.Time
	ExpiresAt      time.Time
}

type CreateAgentSessionParams struct {
	RepoURL       string
	AgentName     *string
	PollTokenHash string
	AgentKeyPub   string
}

// CreateAgentSession creates a pending agent session. Multiple pending
// sessions per repo are allowed; provisioning serializes canonical repo writes.
func (q *Queries) CreateAgentSession(ctx context.Context, p CreateAgentSessionParams) (*AgentSession, error) {
	var s AgentSession
	err := q.pool.QueryRow(ctx,
		`INSERT INTO agent_sessions (repo_url, agent_name, poll_token_hash, agent_key_pub)
		 VALUES ($1, $2, $3, $4)
		 RETURNING id, repo_url, agent_name, status, org_id, project_id,
		           installation_id, created_at, completed_at, expires_at,
		           poll_token_hash, agent_key_pub, api_key_sealed, failure_reason,
		           auth_clicked_at, key_claimed_at`,
		p.RepoURL, p.AgentName, p.PollTokenHash, p.AgentKeyPub,
	).Scan(&s.ID, &s.RepoURL, &s.AgentName, &s.Status, &s.OrgID, &s.ProjectID,
		&s.InstallationID, &s.CreatedAt, &s.CompletedAt, &s.ExpiresAt,
		&s.PollTokenHash, &s.AgentKeyPub, &s.APIKeySealed, &s.FailureReason,
		&s.AuthClickedAt, &s.KeyClaimedAt)
	if err != nil {
		return nil, fmt.Errorf("create agent session: %w", err)
	}
	return &s, nil
}

// GetAgentSession returns an agent session by ID. Returns nil if not found.
func (q *Queries) GetAgentSession(ctx context.Context, sessionID string) (*AgentSession, error) {
	var s AgentSession
	err := q.pool.QueryRow(ctx,
		`SELECT id, repo_url, agent_name, status, org_id, project_id,
		        installation_id, created_at, completed_at, expires_at,
		        poll_token_hash, agent_key_pub, api_key_sealed, failure_reason,
		        auth_clicked_at, key_claimed_at
		 FROM agent_sessions WHERE id = $1`,
		sessionID,
	).Scan(&s.ID, &s.RepoURL, &s.AgentName, &s.Status, &s.OrgID, &s.ProjectID,
		&s.InstallationID, &s.CreatedAt, &s.CompletedAt, &s.ExpiresAt,
		&s.PollTokenHash, &s.AgentKeyPub, &s.APIKeySealed, &s.FailureReason,
		&s.AuthClickedAt, &s.KeyClaimedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get agent session: %w", err)
	}
	return &s, nil
}

// ExpireAgentSessions marks all pending sessions past their expiry as expired.
// Called periodically by the cleanup goroutine.
func (q *Queries) ExpireAgentSessions(ctx context.Context) (int64, error) {
	tag, err := q.pool.Exec(ctx,
		`UPDATE agent_sessions SET status = 'expired'
		 WHERE status = 'pending' AND expires_at <= now()`,
	)
	if err != nil {
		return 0, fmt.Errorf("expire agent sessions: %w", err)
	}
	if _, err := q.pool.Exec(ctx,
		`UPDATE agent_sessions SET api_key_sealed = NULL
		 WHERE status IN ('completed', 'provisioned', 'key_ok', 'app_reporting')
		   AND expires_at <= now() AND api_key_sealed IS NOT NULL`,
	); err != nil {
		return 0, fmt.Errorf("purge sealed agent keys: %w", err)
	}
	return tag.RowsAffected(), nil
}

// MarkAgentKeyDelivered stamps first key delivery. COALESCE makes retries
// idempotent while retaining the first-delivery funnel timestamp.
func (q *Queries) MarkAgentKeyDelivered(ctx context.Context, sessionID string) error {
	_, err := q.pool.Exec(ctx,
		`UPDATE agent_sessions
		 SET key_claimed_at = COALESCE(key_claimed_at, now()),
		     status = CASE WHEN status = 'provisioned' THEN 'key_ok' ELSE status END
		 WHERE id = $1 AND status IN ('completed', 'provisioned', 'key_ok', 'app_reporting')`, sessionID)
	if err != nil {
		return fmt.Errorf("mark agent key delivered: %w", err)
	}
	return nil
}

// MarkAgentSessionsAppReporting advances active onboarding sessions for a
// project when its SDK first registers. The compare-and-set tolerates the
// reporting signal arriving before or after the CLI key probe.
func (q *Queries) MarkAgentSessionsAppReporting(ctx context.Context, projectID string) (int64, error) {
	tag, err := q.pool.Exec(ctx,
		`UPDATE agent_sessions
		 SET status = 'app_reporting', completed_at = COALESCE(completed_at, now())
		 WHERE project_id = $1 AND status IN ('provisioned', 'key_ok')`, projectID)
	if err != nil {
		return 0, fmt.Errorf("mark agent sessions app reporting: %w", err)
	}
	return tag.RowsAffected(), nil
}

// MarkAgentSessionFailed records a definitive business failure. Transient
// failures leave sessions pending so the human can retry the authorization URL.
func (q *Queries) MarkAgentSessionFailed(ctx context.Context, sessionID, reason string) (bool, error) {
	tag, err := q.pool.Exec(ctx,
		`UPDATE agent_sessions SET status = 'failed', failure_reason = $2
		 WHERE id = $1 AND status = 'pending'`, sessionID, reason)
	if err != nil {
		return false, fmt.Errorf("mark agent session failed: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

// MarkAgentSessionAuthClicked stamps the first human click on the auth URL.
func (q *Queries) MarkAgentSessionAuthClicked(ctx context.Context, sessionID string) error {
	_, err := q.pool.Exec(ctx,
		`UPDATE agent_sessions SET auth_clicked_at = COALESCE(auth_clicked_at, now())
		 WHERE id = $1`, sessionID)
	if err != nil {
		return fmt.Errorf("mark agent session auth clicked: %w", err)
	}
	return nil
}

// FindProjectByRepoURL returns the project for a given repo URL (owner/repo format).
// Used by the agent setup flow to detect returning users.
// Returns nil if no project matches.
func (q *Queries) FindProjectByRepoURL(ctx context.Context, repoURL string) (*Project, error) {
	var p Project
	err := q.pool.QueryRow(ctx,
		`SELECT id, org_id, name, github_repo, default_branch, friction_autonomy, pr_posture, default_environment_id, digest_timezone, created_at
		 FROM projects
		 WHERE github_repo = $1
		 ORDER BY created_at ASC
		 LIMIT 1`,
		repoURL,
	).Scan(&p.ID, &p.OrgID, &p.Name, &p.GithubRepo, &p.DefaultBranch, &p.FrictionAutonomy, &p.PrPosture, &p.DefaultEnvironmentID, &p.DigestTimezone, &p.CreatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("find project by repo url: %w", err)
	}
	return &p, nil
}

// === GitHub App installations ===

// GitHubAppInstallation represents a GitHub App installation with org mapping.
type GitHubAppInstallation struct {
	ID             string
	InstallationID int64
	GithubOrgName  string
	GithubOrgID    int64
	OrgID          string
	Repos          []byte // raw JSONB
	Suspended      bool
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

// UpsertGitHubAppInstallation creates or updates a GitHub App installation record.
func (q *Queries) UpsertGitHubAppInstallation(ctx context.Context, installationID int64, githubOrgName string, githubOrgID int64, orgID string, repos []byte) (*GitHubAppInstallation, error) {
	var i GitHubAppInstallation
	err := q.pool.QueryRow(ctx,
		`INSERT INTO github_app_installations (installation_id, github_org_name, github_org_id, org_id, repos)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (installation_id) DO UPDATE
		 SET github_org_name = EXCLUDED.github_org_name,
		     repos = EXCLUDED.repos,
		     updated_at = now()
		 RETURNING id, installation_id, github_org_name, github_org_id, org_id, repos, suspended, created_at, updated_at`,
		installationID, githubOrgName, githubOrgID, orgID, repos,
	).Scan(&i.ID, &i.InstallationID, &i.GithubOrgName, &i.GithubOrgID, &i.OrgID,
		&i.Repos, &i.Suspended, &i.CreatedAt, &i.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("upsert github app installation: %w", err)
	}
	return &i, nil
}

// GetGitHubAppInstallationByID returns an installation by GitHub's installation ID.
func (q *Queries) GetGitHubAppInstallationByID(ctx context.Context, installationID int64) (*GitHubAppInstallation, error) {
	var i GitHubAppInstallation
	err := q.pool.QueryRow(ctx,
		`SELECT id, installation_id, github_org_name, github_org_id, org_id, repos, suspended, created_at, updated_at
		 FROM github_app_installations WHERE installation_id = $1`,
		installationID,
	).Scan(&i.ID, &i.InstallationID, &i.GithubOrgName, &i.GithubOrgID, &i.OrgID,
		&i.Repos, &i.Suspended, &i.CreatedAt, &i.UpdatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get github app installation: %w", err)
	}
	return &i, nil
}
