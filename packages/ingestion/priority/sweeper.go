package priority

import (
	"context"
	"errors"
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
// Those values were normalized by packages/worker/src/friction/fingerprint.ts,
// which keeps the origin and templates fewer segment shapes. Re-normalizing
// them here is what makes both kinds agree: NormalizePageURL strips the host
// and leaves an already-templated ":id" untouched, so a friction incident and
// an error incident on the same page land on the same pattern and therefore
// join the same route_map row. Without this pass they never match, and every
// customer-facing friction issue silently keeps the default weight of 1.
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
  LEFT JOIN route_map rm ON rm.project_id = eg.project_id AND rm.pattern = eg.page_url_normalized
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
  LEFT JOIN route_map rm ON rm.project_id = eg.project_id AND rm.pattern = eg.page_url_normalized
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

const enqueueRouteMapJobsSQL = `
INSERT INTO error_group_jobs (project_id, job_type)
SELECT p.id, 'route_map' FROM projects p
WHERE p.github_repo IS NOT NULL AND p.github_repo <> ''
  AND EXISTS (
    SELECT 1 FROM error_groups eg
    WHERE eg.project_id = p.id AND eg.page_url_normalized IS NOT NULL
      AND eg.status NOT IN ('resolved','merged','archived')
      AND NOT EXISTS (
        SELECT 1 FROM route_map rm
        WHERE rm.project_id = p.id AND rm.pattern = eg.page_url_normalized
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
	if _, err := conn.Exec(ctx, enqueueRouteMapJobsSQL); err != nil {
		return updated, err
	}
	return updated, nil
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
