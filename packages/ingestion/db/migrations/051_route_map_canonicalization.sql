-- C6 step 3: rewrite route_map patterns to path-only with a deterministic,
-- audited collision policy. Every migration is replayed on every boot, so the
-- data rewrite is guarded by applied_data_migrations and runs in one DO block.

CREATE TABLE IF NOT EXISTS route_map_migration_conflicts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id UUID NOT NULL,
  canonical_pattern TEXT NOT NULL,
  kept_pattern TEXT NOT NULL,
  dropped_pattern TEXT NOT NULL,
  kept_name TEXT NOT NULL,
  dropped_name TEXT NOT NULL,
  dropped_source TEXT NOT NULL DEFAULT '',
  dropped_purpose TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
DECLARE
  grp RECORD;
  winner route_map%ROWTYPE;
  twin route_map%ROWTYPE;
  max_tier_rank INTEGER;
  merged_tier TEXT;
  min_created TIMESTAMPTZ;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('051_route_map_canonicalization'));

  IF EXISTS (
    SELECT 1 FROM applied_data_migrations
    WHERE name = '051_route_map_canonicalization'
  ) THEN
    RETURN;
  END IF;

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
    -- Conservative reach (#310: never silently downgrade), EXCEPT when the
    -- surviving row is a human classification. The runtime already refuses to
    -- overwrite a human row (upsertRouteMapRows' ON CONFLICT ... WHERE
    -- source <> 'human'); promoting an operator's deliberate 'admin' to
    -- 'customer' because an LLM twin guessed higher would reverse that call
    -- through the back door.
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
           winner.name, twin.name, twin.source, twin.purpose, 'name_conflict');
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

  INSERT INTO applied_data_migrations (name)
  VALUES ('051_route_map_canonicalization');
END $$;
