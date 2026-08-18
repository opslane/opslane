package priority

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const cappedReasonCodes = `('unfixable_third_party','unfixable_no_app_frames','unfixable_infra','unfixable_test_error','triage_unfixable')`

// sweepAdvisoryLockKey is 0x707269_6F7269, ASCII "priori". Every replica runs
// the sweeper, but unlike the scrubber this pass claims no rows, so without a
// lock N replicas each rewrite every open group on every tick: N times the
// dead tuples and WAL, replicas blocking each other for the length of the
// pass, and a slower replica's older snapshot able to overwrite a newer
// route winner.
const sweepAdvisoryLockKey int64 = 0x7072696F7269

// maxURLsPerGroup bounds how many distinct raw URLs one group contributes to
// the winner election. The tallies are grouped by the *raw* URL, so a single
// route carrying a query string mints a row per distinct value; without this
// bound one search box makes the result set — and the Go map built from it —
// grow without limit inside the process that also serves all HTTP traffic.
// The winner is by far the most frequent URL, so a deep tail cannot change it.
const maxURLsPerGroup = 20

const (
	impactWindowDays = 30
	impactRecoveryMs = 60_000
)

// Raw URLs for open error groups, capped per group. Ranking happens in SQL so
// the tail never reaches this process.
const rawURLTalliesSQL = `
SELECT error_group_id, url, n, latest FROM (
  SELECT ee.error_group_id, ee.context->>'url' AS url, count(*) AS n, max(ee.created_at) AS latest,
         row_number() OVER (PARTITION BY ee.error_group_id
                            ORDER BY count(*) DESC, max(ee.created_at) DESC) AS rn
  FROM error_events ee
  JOIN error_groups eg ON eg.id = ee.error_group_id AND ee.project_id = eg.project_id
  WHERE eg.kind = 'error' AND eg.status NOT IN ('resolved','merged','archived')
    AND ee.created_at > now() - interval '7 days' AND ee.context->>'url' IS NOT NULL
  GROUP BY ee.error_group_id, ee.context->>'url'
) ranked WHERE rn <= $1`

// Friction incidents carry their page URL on the signal rather than the event.
// Version 4 writes the same host-free contract as ingestion. Re-normalization
// stays defensive because version 3 rows retain origins and can still flow
// through this seven-day tally during the cutover window.
const frictionURLTalliesSQL = `
SELECT error_group_id, url, n, latest FROM (
  SELECT fs.incident_id AS error_group_id, fs.page_url_normalized AS url,
         count(*) AS n, max(fs.created_at) AS latest,
         row_number() OVER (PARTITION BY fs.incident_id
                            ORDER BY count(*) DESC, max(fs.created_at) DESC) AS rn
  FROM friction_signals fs
  JOIN error_groups eg ON eg.id = fs.incident_id AND eg.project_id = fs.project_id
  WHERE eg.kind = 'friction' AND eg.status NOT IN ('resolved','merged','archived')
    AND fs.created_at > now() - interval '7 days'
    AND fs.page_url_normalized IS NOT NULL AND fs.page_url_normalized <> ''
    AND fs.superseded_by IS NULL AND fs.retracted_at IS NULL
  GROUP BY fs.incident_id, fs.page_url_normalized
) ranked WHERE rn <= $1`

// One statement per pass instead of one round trip per group.
const stampPatternsSQL = `
UPDATE error_groups eg SET page_url_normalized = v.pattern
FROM unnest($1::uuid[], $2::text[]) AS v(id, pattern)
WHERE eg.id = v.id AND eg.page_url_normalized IS DISTINCT FROM v.pattern`

const scoreErrorGroupsSQL = `
WITH windows AS (
  SELECT eg.id, eg.reason_code, eg.page_url_normalized,
    rm.name AS route_name, rm.tier AS route_tier,
    COALESCE(CASE rm.tier WHEN 'customer' THEN 3.0 WHEN 'admin' THEN 0.5 WHEN 'standard' THEN 1.0 END, 1.0) AS route_weight,
    (SELECT count(*) FROM error_group_affected_users u
      WHERE u.error_group_id = eg.id AND u.last_seen > now() - interval '7 days') AS users_7d,
    (SELECT count(*) FROM error_group_affected_users u
      WHERE u.error_group_id = eg.id AND u.last_seen > now() - interval '24 hours') AS users_24h,
    (SELECT count(*) FROM (
      SELECT ee.session_id FROM error_events ee
      WHERE ee.error_group_id = eg.id AND ee.project_id = eg.project_id
        AND ee.session_id IS NOT NULL AND ee.created_at > now() - interval '7 days'
      GROUP BY ee.session_id HAVING bool_and(ee.end_user_id IS NULL)
    ) a7) AS anon_7d,
    (SELECT count(*) FROM (
      SELECT ee.session_id FROM error_events ee
      WHERE ee.error_group_id = eg.id AND ee.project_id = eg.project_id
        AND ee.session_id IS NOT NULL AND ee.created_at > now() - interval '24 hours'
      GROUP BY ee.session_id HAVING bool_and(ee.end_user_id IS NULL)
    ) a24) AS anon_24h
  FROM error_groups eg
  LEFT JOIN LATERAL (
    SELECT rm.pattern, rm.name, rm.tier
    FROM route_map rm
    WHERE rm.project_id = eg.project_id
      -- A group with no page URL matches nothing. Without this guard the
      -- COALESCE below turns NULL and '' into '/', so every URL-less group
      -- would inherit the project's root route and its weight. The old
      -- equality join could not do that: NULL = anything is never true.
      AND eg.page_url_normalized IS NOT NULL AND eg.page_url_normalized <> ''
      AND COALESCE(NULLIF(regexp_replace(rm.pattern, '^https?://[^/]*', '', 'i'), ''), '/')
        = COALESCE(NULLIF(regexp_replace(eg.page_url_normalized, '^https?://[^/]*', '', 'i'), ''), '/')
    ORDER BY (rm.pattern = eg.page_url_normalized) DESC,
             (rm.pattern !~* '^https?://') DESC,
             rm.created_at, rm.pattern
    LIMIT 1
  ) rm ON TRUE
  WHERE eg.kind = 'error' AND eg.status NOT IN ('resolved','merged','archived')
)
UPDATE error_groups eg SET
  priority_score = sub.score, priority_scored_at = now(), priority_inputs = sub.inputs
FROM (
  SELECT w.id,
    ((w.users_7d + w.anon_7d) + 2 * (w.users_24h + w.anon_24h))
      * w.route_weight
      * (CASE WHEN w.reason_code IN ` + cappedReasonCodes + ` THEN 0.1 ELSE 1 END) AS score,
    jsonb_build_object(
      'users_7d', w.users_7d, 'anon_sessions_7d', w.anon_7d,
      'users_24h', w.users_24h, 'anon_sessions_24h', w.anon_24h,
      'impact', (w.users_7d + w.anon_7d) + 2 * (w.users_24h + w.anon_24h),
      'route_pattern', w.page_url_normalized,
      'route_name', w.route_name, 'route_tier', w.route_tier, 'route_weight', w.route_weight,
      'cap_applied', COALESCE(w.reason_code IN ` + cappedReasonCodes + `, false),
      'reason_code', w.reason_code) AS inputs
  FROM windows w
) sub
WHERE eg.id = sub.id`

const scoreFrictionGroupsSQL = `
WITH windows AS (
  SELECT eg.id, eg.reason_code, eg.page_url_normalized,
    rm.name AS route_name, rm.tier AS route_tier,
    COALESCE(CASE rm.tier WHEN 'customer' THEN 3.0 WHEN 'admin' THEN 0.5 WHEN 'standard' THEN 1.0 END, 1.0) AS route_weight,
    (SELECT count(DISTINCT fs.end_user_id) FROM friction_signals fs
      WHERE fs.incident_id = eg.id AND fs.project_id = eg.project_id AND fs.end_user_id IS NOT NULL
        AND fs.superseded_by IS NULL AND fs.retracted_at IS NULL AND fs.adjudication_status = 'accepted'
        AND fs.created_at > now() - interval '7 days') AS users_7d,
    (SELECT count(DISTINCT fs.end_user_id) FROM friction_signals fs
      WHERE fs.incident_id = eg.id AND fs.project_id = eg.project_id AND fs.end_user_id IS NOT NULL
        AND fs.superseded_by IS NULL AND fs.retracted_at IS NULL AND fs.adjudication_status = 'accepted'
        AND fs.created_at > now() - interval '24 hours') AS users_24h,
    (SELECT count(*) FROM (
      SELECT fs.session_id FROM friction_signals fs
      WHERE fs.incident_id = eg.id AND fs.project_id = eg.project_id
        AND fs.superseded_by IS NULL AND fs.retracted_at IS NULL AND fs.adjudication_status = 'accepted'
        AND fs.created_at > now() - interval '7 days'
      GROUP BY fs.session_id HAVING bool_and(fs.end_user_id IS NULL)
    ) a7) AS anon_7d,
    (SELECT count(*) FROM (
      SELECT fs.session_id FROM friction_signals fs
      WHERE fs.incident_id = eg.id AND fs.project_id = eg.project_id
        AND fs.superseded_by IS NULL AND fs.retracted_at IS NULL AND fs.adjudication_status = 'accepted'
        AND fs.created_at > now() - interval '24 hours'
      GROUP BY fs.session_id HAVING bool_and(fs.end_user_id IS NULL)
    ) a24) AS anon_24h
  FROM error_groups eg
  LEFT JOIN LATERAL (
    SELECT rm.pattern, rm.name, rm.tier
    FROM route_map rm
    WHERE rm.project_id = eg.project_id
      -- A group with no page URL matches nothing. Without this guard the
      -- COALESCE below turns NULL and '' into '/', so every URL-less group
      -- would inherit the project's root route and its weight. The old
      -- equality join could not do that: NULL = anything is never true.
      AND eg.page_url_normalized IS NOT NULL AND eg.page_url_normalized <> ''
      AND COALESCE(NULLIF(regexp_replace(rm.pattern, '^https?://[^/]*', '', 'i'), ''), '/')
        = COALESCE(NULLIF(regexp_replace(eg.page_url_normalized, '^https?://[^/]*', '', 'i'), ''), '/')
    ORDER BY (rm.pattern = eg.page_url_normalized) DESC,
             (rm.pattern !~* '^https?://') DESC,
             rm.created_at, rm.pattern
    LIMIT 1
  ) rm ON TRUE
  WHERE eg.kind = 'friction' AND eg.status NOT IN ('resolved','merged','archived')
)
UPDATE error_groups eg SET
  priority_score = sub.score, priority_scored_at = now(), priority_inputs = sub.inputs
FROM (
  SELECT w.id,
    ((w.users_7d + w.anon_7d) + 2 * (w.users_24h + w.anon_24h))
      * w.route_weight
      * (CASE WHEN w.reason_code IN ` + cappedReasonCodes + ` THEN 0.1 ELSE 1 END) AS score,
    jsonb_build_object(
      'users_7d', w.users_7d, 'anon_sessions_7d', w.anon_7d,
      'users_24h', w.users_24h, 'anon_sessions_24h', w.anon_24h,
      'impact', (w.users_7d + w.anon_7d) + 2 * (w.users_24h + w.anon_24h),
      'route_pattern', w.page_url_normalized,
      'route_name', w.route_name, 'route_tier', w.route_tier, 'route_weight', w.route_weight,
      'cap_applied', COALESCE(w.reason_code IN ` + cappedReasonCodes + `, false),
      'reason_code', w.reason_code) AS inputs
  FROM windows w
) sub
WHERE eg.id = sub.id`

// ImpactRollupSelectSQL is shared with the planner regression test so the
// measured query is exactly the query production materializes. Occurrence
// time and chunk bounds are both client-clock values; created_at is not a
// valid substitute for this arithmetic.
var ImpactRollupSelectSQL = fmt.Sprintf(`
WITH open_groups AS (
  SELECT id, project_id, kind
  FROM error_groups
  WHERE status NOT IN ('resolved','merged','archived')
), err_sess AS (
  SELECT g.id AS group_id, e.project_id, e.session_id,
         (max(extract(epoch FROM e."timestamp")) * 1000)::bigint AS last_hit_ms
  FROM open_groups g
  JOIN error_events e ON e.error_group_id = g.id AND e.project_id = g.project_id
  WHERE g.kind = 'error'
    AND e.session_id IS NOT NULL
    AND e."timestamp" > now() - interval '%d days'
  GROUP BY 1, 2, 3
), fric_sess AS (
  SELECT g.id AS group_id, fs.project_id, fs.session_id,
         (max(extract(epoch FROM fs.occurred_at)) * 1000)::bigint AS last_hit_ms
  FROM open_groups g
  JOIN friction_signals fs ON fs.incident_id = g.id AND fs.project_id = g.project_id
  WHERE g.kind = 'friction'
    AND fs.adjudication_status = 'accepted'
    AND fs.retracted_at IS NULL
    AND fs.superseded_by IS NULL
    AND fs.occurred_at > now() - interval '%d days'
  GROUP BY 1, 2, 3
), sess AS (
  SELECT * FROM err_sess
  UNION ALL
  SELECT * FROM fric_sess
), chunks AS (
  -- Per-session LATERAL against the (session_id, seq) PK: the rollup's chunk
  -- reads stay proportional to the in-window session set, never a scan of the
  -- always-on-recording chunk table (the semi-join form left the planner free
  -- to hash-join a full scan of scrubbed chunks every sweep).
  SELECT sk.project_id, sk.session_id, agg.last_activity_ms
  FROM (SELECT DISTINCT project_id, session_id FROM sess) sk
  CROSS JOIN LATERAL (
    SELECT max(c.last_event_ms) AS last_activity_ms
    FROM session_chunks c
    WHERE c.session_id = sk.session_id AND c.project_id = sk.project_id
      AND c.scrubbed_at IS NOT NULL
      AND c.first_event_ms IS NOT NULL
      AND c.last_event_ms IS NOT NULL
  ) agg
  WHERE agg.last_activity_ms IS NOT NULL
)
SELECT sess.group_id,
       count(*)::bigint AS visits,
       (count(*) FILTER (
          WHERE chunks.last_activity_ms >= sess.last_hit_ms + %d
       ))::bigint AS recovered
FROM sess
JOIN chunks ON chunks.project_id = sess.project_id
           AND chunks.session_id = sess.session_id
GROUP BY 1`, impactWindowDays, impactWindowDays, impactRecoveryMs)

const stampImpactSQL = `
UPDATE error_groups g SET
  impact_visits = r.visits,
  impact_visits_recovered = r.recovered,
  impact_class = CASE
    WHEN r.recovered = 0 THEN 'blocked'
    WHEN r.recovered < r.visits THEN 'degraded'
    ELSE 'invisible'
  END,
  impact_computed_at = now()
FROM impact_rollup r
WHERE g.id = r.group_id
  AND g.status NOT IN ('resolved','merged','archived')`

const clearStaleImpactSQL = `
UPDATE error_groups g SET
  impact_class = NULL,
  impact_visits = NULL,
  impact_visits_recovered = NULL,
  impact_computed_at = NULL
WHERE g.status NOT IN ('resolved','merged','archived')
  AND (g.impact_class IS NOT NULL
       OR g.impact_visits IS NOT NULL
       OR g.impact_visits_recovered IS NOT NULL
       OR g.impact_computed_at IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1 FROM impact_rollup r WHERE r.group_id = g.id
  )`

// Reads error_groups rows that the identity settlement loop (Slice 4) creates
// from captured observations and that stampPatternsSQL above annotates with a
// normalized page URL. A session revealing an unknown route therefore reaches
// this trigger only after settlement has attached its event to an issue.
const enqueueRouteMapJobsSQL = `
INSERT INTO error_group_jobs (project_id, job_type)
SELECT p.id, 'route_map' FROM projects p
WHERE p.github_repo IS NOT NULL AND p.github_repo <> ''
  AND EXISTS (
    SELECT 1 FROM error_groups eg
    WHERE eg.project_id = p.id AND eg.page_url_normalized IS NOT NULL
      AND eg.page_url_normalized <> ''
      AND eg.status NOT IN ('resolved','merged','archived')
      AND NOT EXISTS (
        SELECT 1 FROM route_map rm
        WHERE rm.project_id = p.id
          AND COALESCE(NULLIF(regexp_replace(rm.pattern, '^https?://[^/]*', '', 'i'), ''), '/')
            = COALESCE(NULLIF(regexp_replace(eg.page_url_normalized, '^https?://[^/]*', '', 'i'), ''), '/')
      )
  )
  AND NOT EXISTS (
    SELECT 1 FROM error_group_jobs j
    WHERE j.project_id = p.id AND j.job_type = 'route_map'
      AND (j.status IN ('pending','claimed') OR j.created_at > now() - interval '24 hours')
  )
ON CONFLICT (project_id, job_type) WHERE job_type = 'route_map' AND status IN ('pending','claimed')
DO NOTHING`

// Sweeper owns one complete priority recomputation pass.
type Sweeper struct {
	Pool *pgxpool.Pool
}

func (s *Sweeper) Start(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = 30 * time.Minute
	}
	s.runPass(ctx)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.runPass(ctx)
		}
	}
}

func (s *Sweeper) runPass(ctx context.Context) {
	updated, err := s.RunOnce(ctx)
	if err != nil {
		slog.Error("priority sweep failed", "error", err)
		return
	}
	slog.Info("priority sweep", "groups_scored", updated)
}

// RunOnce stamps recent top routes, scores every open group, and enqueues any
// code-grounded route classification work that is now needed.
//
// Only one replica runs a pass at a time. The advisory lock is held on a
// single pooled connection for the duration and released before returning; a
// replica that cannot take it skips this tick rather than queueing, because a
// skipped pass costs nothing but a duplicated one costs a full table rewrite.
func (s *Sweeper) RunOnce(ctx context.Context) (int, error) {
	if s.Pool == nil {
		return 0, errors.New("priority pool is not configured")
	}
	conn, err := s.Pool.Acquire(ctx)
	if err != nil {
		return 0, err
	}
	defer conn.Release()

	var locked bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, sweepAdvisoryLockKey).Scan(&locked); err != nil {
		return 0, err
	}
	if !locked {
		slog.Debug("priority sweep skipped: another replica holds the lock")
		return 0, nil
	}
	defer func() {
		// Best effort: a dropped connection releases a session lock anyway.
		_, _ = conn.Exec(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock($1)`, sweepAdvisoryLockKey)
	}()

	for _, query := range []string{rawURLTalliesSQL, frictionURLTalliesSQL} {
		if err := s.stampTopURLs(ctx, conn, query); err != nil {
			return 0, err
		}
	}
	updated := 0
	for _, query := range []string{scoreErrorGroupsSQL, scoreFrictionGroupsSQL} {
		tag, err := conn.Exec(ctx, query)
		if err != nil {
			return updated, err
		}
		updated += int(tag.RowsAffected())
	}
	if err := s.stampImpact(ctx, conn); err != nil {
		return updated, fmt.Errorf("impact: %w", err)
	}
	if _, err := conn.Exec(ctx, enqueueRouteMapJobsSQL); err != nil {
		return updated, err
	}
	return updated, nil
}

// stampImpact materializes both occurrence lanes and applies the stamp and
// stale clear atomically on the advisory-lock connection held by RunOnce.
func (s *Sweeper) stampImpact(ctx context.Context, conn *pgxpool.Conn) error {
	tx, err := conn.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()

	if _, err := tx.Exec(ctx, `CREATE TEMPORARY TABLE impact_rollup ON COMMIT DROP AS `+ImpactRollupSelectSQL); err != nil {
		return fmt.Errorf("rollup: %w", err)
	}
	stamped, err := tx.Exec(ctx, stampImpactSQL)
	if err != nil {
		return fmt.Errorf("stamp: %w", err)
	}
	cleared, err := tx.Exec(ctx, clearStaleImpactSQL)
	if err != nil {
		return fmt.Errorf("clear stale: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	slog.Debug("priority impact pass", "groups_stamped", stamped.RowsAffected(), "groups_cleared", cleared.RowsAffected())
	return nil
}

type routeTally struct {
	count  int64
	latest time.Time
}

// stampTopURLs elects one normalized pattern per group and writes them all in
// a single statement. Both kinds run through NormalizePageURL so error and
// friction incidents on the same page produce the same route_map key.
func (s *Sweeper) stampTopURLs(ctx context.Context, conn *pgxpool.Conn, tallySQL string) error {
	rows, err := conn.Query(ctx, tallySQL, maxURLsPerGroup)
	if err != nil {
		return err
	}
	defer rows.Close()

	groupTallies := make(map[string]map[string]routeTally)
	for rows.Next() {
		var groupID, raw string
		var count int64
		var latest time.Time
		if err := rows.Scan(&groupID, &raw, &count, &latest); err != nil {
			return err
		}
		pattern := NormalizePageURL(raw)
		if pattern == "" {
			continue
		}
		if groupTallies[groupID] == nil {
			groupTallies[groupID] = make(map[string]routeTally)
		}
		cur := groupTallies[groupID][pattern]
		cur.count += count
		if latest.After(cur.latest) {
			cur.latest = latest
		}
		groupTallies[groupID][pattern] = cur
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if len(groupTallies) == 0 {
		return nil
	}

	groupIDs := make([]string, 0, len(groupTallies))
	for groupID := range groupTallies {
		groupIDs = append(groupIDs, groupID)
	}
	sort.Strings(groupIDs)

	ids := make([]string, 0, len(groupIDs))
	winners := make([]string, 0, len(groupIDs))
	for _, groupID := range groupIDs {
		patterns := make([]string, 0, len(groupTallies[groupID]))
		for pattern := range groupTallies[groupID] {
			patterns = append(patterns, pattern)
		}
		sort.Strings(patterns)
		winner := patterns[0]
		for _, pattern := range patterns[1:] {
			candidate, best := groupTallies[groupID][pattern], groupTallies[groupID][winner]
			if candidate.count > best.count || (candidate.count == best.count && candidate.latest.After(best.latest)) {
				winner = pattern
			}
		}
		ids = append(ids, groupID)
		winners = append(winners, winner)
	}
	_, err = conn.Exec(ctx, stampPatternsSQL, ids, winners)
	return err
}
