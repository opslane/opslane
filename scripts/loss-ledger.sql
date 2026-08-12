-- W4.M. Read-only. Run with: psql -X -f scripts/loss-ledger.sql
\pset format aligned
\pset footer off
\pset null ''

-- Receipt is mechanical: digest_readiness.status = 'eligible'.
-- Row grammar: ord | section | k1 | k2 | n_groups | n_users | pct
WITH open_groups AS (
  SELECT g.id, g.kind, g.status,
         COALESCE(g.affected_users_count, 0) AS affected_users,
         dr.status AS readiness, dr.reason
    FROM error_groups g
    LEFT JOIN digest_readiness dr ON dr.incident_id = g.id
   WHERE g.status NOT IN ('resolved','merged','archived')
)
SELECT 1 AS ord, 'totals_error' AS section,
       'receipt_groups:' || count(*) FILTER (WHERE readiness = 'eligible') AS k1,
       'receipt_users:' || COALESCE(sum(affected_users) FILTER (WHERE readiness = 'eligible'), 0) AS k2,
       count(*)::text AS n_groups,
       COALESCE(sum(affected_users), 0)::text AS n_users,
       round(100.0 * COALESCE(sum(affected_users) FILTER (WHERE readiness = 'eligible'), 0)
             / GREATEST(COALESCE(sum(affected_users), 0), 1), 1)::text AS pct
  FROM open_groups WHERE kind = 'error'
UNION ALL
SELECT 2, 'totals_all',
       'receipt_groups:' || count(*) FILTER (WHERE readiness = 'eligible'),
       'receipt_users:' || COALESCE(sum(affected_users) FILTER (WHERE readiness = 'eligible'), 0),
       count(*)::text, COALESCE(sum(affected_users), 0)::text,
       round(100.0 * COALESCE(sum(affected_users) FILTER (WHERE readiness = 'eligible'), 0)
             / GREATEST(COALESCE(sum(affected_users), 0), 1), 1)::text
  FROM open_groups
UNION ALL
SELECT 3, 'by_readiness', COALESCE(readiness, 'absent'), COALESCE(reason, ''),
       count(*)::text, COALESCE(sum(affected_users), 0)::text, ''
  FROM open_groups GROUP BY readiness, reason
UNION ALL
SELECT 4, 'by_status', status::text, '', count(*)::text,
       COALESCE(sum(affected_users), 0)::text, ''
  FROM open_groups GROUP BY status
 ORDER BY 1, 3, 4;
