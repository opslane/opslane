-- C6 step 5: sweep any route_map stragglers that landed after canonicalization,
-- then enforce path-only patterns at the database boundary. The sweep and
-- CHECK installation share one transaction and table lock, leaving no gap for
-- an origin-full write to slip through.

DO $$
DECLARE
  grp RECORD;
  winner route_map%ROWTYPE;
  twin route_map%ROWTYPE;
  max_tier_rank INTEGER;
  merged_tier TEXT;
  min_created TIMESTAMPTZ;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('052_route_map_enforcement'));
  LOCK TABLE route_map IN SHARE ROW EXCLUSIVE MODE;

  FOR grp IN
    SELECT project_id,
           COALESCE(NULLIF(regexp_replace(pattern, '^https?://[^/]*', '', 'i'), ''), '/') AS canonical
    FROM route_map
    WHERE pattern ~* '^https?://'
    GROUP BY 1, 2
    ORDER BY 1, 2
  LOOP
    SELECT * INTO winner
    FROM route_map rm
    WHERE rm.project_id = grp.project_id
      AND COALESCE(NULLIF(regexp_replace(rm.pattern, '^https?://[^/]*', '', 'i'), ''), '/') = grp.canonical
    ORDER BY CASE rm.source WHEN 'human' THEN 2 WHEN 'llm' THEN 1 ELSE 0 END DESC,
             (rm.pattern !~* '^https?://') DESC,
             CASE rm.tier WHEN 'customer' THEN 2 WHEN 'standard' THEN 1 ELSE 0 END DESC,
             rm.created_at,
             rm.pattern
    LIMIT 1;

    SELECT max(CASE rm.tier WHEN 'customer' THEN 2 WHEN 'standard' THEN 1 ELSE 0 END),
           min(rm.created_at)
    INTO max_tier_rank, min_created
    FROM route_map rm
    WHERE rm.project_id = grp.project_id
      AND COALESCE(NULLIF(regexp_replace(rm.pattern, '^https?://[^/]*', '', 'i'), ''), '/') = grp.canonical;
    -- Same rule as 051: conservative reach, except a human classification
    -- keeps its own tier rather than being promoted by an LLM twin.
    IF winner.source = 'human' THEN
      merged_tier := winner.tier;
    ELSE
      merged_tier := CASE max_tier_rank WHEN 2 THEN 'customer' WHEN 1 THEN 'standard' ELSE 'admin' END;
    END IF;

    FOR twin IN
      SELECT *
      FROM route_map rm
      WHERE rm.project_id = grp.project_id
        AND COALESCE(NULLIF(regexp_replace(rm.pattern, '^https?://[^/]*', '', 'i'), ''), '/') = grp.canonical
        AND rm.pattern <> winner.pattern
    LOOP
      IF lower(twin.name) <> lower(winner.name) THEN
        INSERT INTO route_map_migration_conflicts
          (project_id, canonical_pattern, kept_pattern, dropped_pattern,
           kept_name, dropped_name, dropped_source, dropped_purpose, reason)
        VALUES
          (grp.project_id, grp.canonical, winner.pattern, twin.pattern,
           winner.name, twin.name, twin.source, twin.purpose, 'post_migration_straggler');
      END IF;
      DELETE FROM route_map
      WHERE project_id = twin.project_id AND pattern = twin.pattern;
    END LOOP;

    UPDATE route_map
    SET pattern = grp.canonical,
        tier = merged_tier,
        created_at = min_created
    WHERE project_id = winner.project_id AND pattern = winner.pattern;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'route_map'::regclass
      AND conname = 'route_map_pattern_path_only'
  ) THEN
    ALTER TABLE route_map
      ADD CONSTRAINT route_map_pattern_path_only
      CHECK (pattern !~* '^https?://');
  END IF;
END $$;
