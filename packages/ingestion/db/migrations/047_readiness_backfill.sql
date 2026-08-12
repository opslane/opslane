-- C3/W3.B: classify every open legacy incident into digest_readiness. This is
-- a one-shot data migration: steady-state worker and requeue writers own all
-- later transitions, and boot-time replay must never overwrite them.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM applied_data_migrations WHERE name = '047_readiness_backfill'
  ) THEN
    INSERT INTO digest_readiness (incident_id, project_id, status, reason)
    SELECT g.id,
           g.project_id,
           CASE
             WHEN classification.receipt_state OR classification.validated_cause
               THEN 'eligible'
             ELSE 'pending'
           END,
           CASE
             WHEN classification.receipt_state THEN 'backfill_receipt_state'
             WHEN classification.validated_cause THEN 'backfill_validated_cause'
             ELSE 'backfill_unverified'
           END
      FROM error_groups g
      CROSS JOIN LATERAL (
        SELECT
          (
            g.status IN ('pr_created', 'pr_draft')
            OR (
              g.status = 'needs_human'
              AND (
                NULLIF(btrim(g.candidate_diff), '') IS NOT NULL
                OR CASE
                  WHEN jsonb_typeof(g.verification_evidence->'checks') = 'array'
                    THEN EXISTS (
                      SELECT 1
                        FROM jsonb_array_elements(g.verification_evidence->'checks') check_item
                       WHERE btrim(coalesce(check_item->>'name', '')) <> ''
                    )
                  ELSE false
                END
              )
            )
          ) AS receipt_state,
          EXISTS (
            SELECT 1
              FROM (
                SELECT d.outcome, d.diagnosis
                  FROM diagnosis_decisions d
                 WHERE d.error_group_id = g.id
                   AND d.project_id = g.project_id
                 ORDER BY d.decided_at DESC, d.id DESC
                 LIMIT 1
              ) latest
             WHERE latest.outcome IN ('code_fix', 'not_actionable')
               AND CASE
                 WHEN jsonb_typeof(latest.diagnosis->'evidence') = 'array'
                   THEN jsonb_array_length(latest.diagnosis->'evidence') >= 1
                    AND NOT EXISTS (
                      SELECT 1
                        FROM jsonb_array_elements(latest.diagnosis->'evidence') evidence_item
                       WHERE btrim(coalesce(evidence_item->>'path', '')) = ''
                          OR btrim(coalesce(evidence_item->>'detail', '')) = ''
                          OR btrim(coalesce(evidence_item->>'symptomLink', '')) = ''
                    )
                 ELSE false
               END
               AND (
                 latest.outcome <> 'code_fix'
                 OR (
                   NULLIF(btrim(latest.diagnosis->>'agentTaskBrief'), '') IS NOT NULL
                   AND latest.diagnosis->>'agentTaskBrief'
                     !~* '^\s*(placeholder|tbd|to be determined)\M'
                 )
               )
          ) AS validated_cause
      ) classification
     WHERE g.status NOT IN ('resolved', 'merged', 'archived')
       AND NOT EXISTS (
         SELECT 1 FROM digest_readiness readiness WHERE readiness.incident_id = g.id
       )
    ON CONFLICT (incident_id) DO NOTHING;

    INSERT INTO applied_data_migrations (name)
    VALUES ('047_readiness_backfill');
  END IF;
END
$$;
