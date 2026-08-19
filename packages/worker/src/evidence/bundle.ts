import { getPool } from '../db.js';
import type { EnvelopeV2 } from '../resolve/envelope.js';
import { normalizePageUrl } from '../friction/urlnorm.js';

const MAX_FRAMES = 20;
const MAX_FAILED_REQUESTS = 100;
const MAX_WRITE_ROLLUPS = 100;
const MAX_RELATED_CANDIDATES = 10;

type ResolutionStatus = 'resolved' | 'no_map' | 'failed' | 'pending' | 'missing';
type RecordingAvailability = 'available' | 'partial' | 'expired' | 'missing';

export interface ResolvedFrameEvidence {
  sourceEventId: string;
  status: ResolutionStatus;
  resolverVersion: number | null;
  envelope: EnvelopeV2 | null;
  commitSha: string | null;
}

export interface FailedRequestEvidence {
  sessionId: string;
  requestIdHash: string;
  pageRoute: string;
  method: string;
  endpointPattern: string;
  status: number;
  actionKind: 'click' | 'form_submit' | null;
  actionSelector: string | null;
  actionLink: 'direct' | 'none';
  occurredAt: string;
  ruleVersion: number;
}

export interface WriteRollupEvidence {
  sessionId: string;
  pageRoute: string;
  method: string;
  endpointPattern: string;
  statusClass: number;
  occurrenceCount: number;
  ruleVersion: number;
}

export interface ProductContextEvidence {
  route: string;
  name: string;
  purpose: string;
  tier: string;
  actions: string[];
  clientRefs: string[];
  serverRefs: string[];
  observedRequests: string[];
  audience: string;
  confidence: number;
  commitSha: string | null;
  promptVersion: number | null;
  model: string | null;
  source: string;
}

export interface ReplayPointer {
  anchorKind: 'threshold' | 'first' | 'recent';
  eventId: string;
  sessionId: string;
  anchorMs: number;
}

export interface RelatedCandidate {
  issueId: string;
  title: string;
  route: string;
}

export interface EvidenceBundle {
  frames: ResolvedFrameEvidence;
  failedRequests: FailedRequestEvidence[];
  writeRollups: WriteRollupEvidence[];
  productContext: ProductContextEvidence[];
  replayPointers: ReplayPointer[];
  availability: {
    recording: RecordingAvailability;
    sourceMap: ResolutionStatus;
  };
  affectedUnits: number;
  relatedCandidates: RelatedCandidate[];
}

interface AnchorRow {
  anchor_kind: ReplayPointer['anchorKind'];
  event_id: string;
  session_id: string | null;
  event_at: Date | string;
  commit_sha: string | null;
  retained_session_id: string | null;
  resolution_status: Exclude<ResolutionStatus, 'missing'> | null;
  envelope: unknown;
  resolver_version: number | null;
  route_url: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function envelopeV2(value: unknown): EnvelopeV2 | null {
  if (!isRecord(value) || value['version'] !== 2 || !Array.isArray(value['frames'])) return null;
  const frames: EnvelopeV2['frames'] = [];
  for (const raw of value['frames'].slice(0, MAX_FRAMES)) {
    if (!isRecord(raw) || !isRecord(raw['generated'])) return null;
    const originalFile = raw['original_file'];
    const originalFunction = raw['original_function'];
    const originalLine = raw['original_line'];
    const generatedLine = raw['generated']['line'];
    const generatedColumn = raw['generated']['column'];
    if (
      typeof originalFile !== 'string' || typeof originalFunction !== 'string'
      || typeof originalLine !== 'number' || typeof generatedLine !== 'number'
      || typeof generatedColumn !== 'number'
    ) return null;
    frames.push({
      original_file: originalFile,
      original_function: originalFunction,
      original_line: originalLine,
      generated: { line: generatedLine, column: generatedColumn },
    });
  }
  return { version: 2, frames };
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function recordingAvailability(anchors: AnchorRow[]): RecordingAvailability {
  const referenced = new Set(
    anchors.map((anchor) => anchor.session_id).filter((id): id is string => id !== null),
  );
  if (referenced.size === 0) return 'missing';
  const retained = new Set(
    anchors.map((anchor) => anchor.retained_session_id).filter((id): id is string => id !== null),
  );
  if (retained.size === 0) return 'expired';
  return retained.size === referenced.size ? 'available' : 'partial';
}

/**
 * Assemble the durable, bounded evidence for one work round. Every source row
 * is reached through issue_evidence_anchors; the mutable group sample is not
 * part of this read path.
 */
export async function loadEvidence(projectId: string, episodeId: string): Promise<EvidenceBundle> {
  const pool = getPool();
  const anchorsResult = await pool.query<AnchorRow>(
    `SELECT a.anchor_kind, a.event_id, e.session_id, e.timestamp AS event_at,
            e.commit_sha,
            CASE WHEN s.status <> 'deleting' THEN s.id END AS retained_session_id,
            r.status AS resolution_status, r.envelope, r.resolver_version,
            e.context->>'url' AS route_url
       FROM issue_evidence_anchors a
       JOIN error_events e
         ON e.id=a.event_id AND e.project_id=a.project_id
       LEFT JOIN sessions s
         ON s.id=e.session_id AND s.project_id=a.project_id
       LEFT JOIN error_event_resolutions r
         ON r.event_id=a.event_id AND r.project_id=a.project_id
      WHERE a.project_id=$1 AND a.episode_id=$2
      ORDER BY CASE a.anchor_kind WHEN 'threshold' THEN 0 WHEN 'first' THEN 1 ELSE 2 END`,
    [projectId, episodeId],
  );
  if (anchorsResult.rowCount === 0) {
    throw new Error(`no frozen anchors for episode ${episodeId}`);
  }
  const anchors = anchorsResult.rows;
  const threshold = anchors.find((anchor) => anchor.anchor_kind === 'threshold');
  if (!threshold) throw new Error(`no threshold anchor for episode ${episodeId}`);

  const retainedSessionIds = [...new Set(
    anchors
      .map((anchor) => anchor.retained_session_id)
      .filter((id): id is string => id !== null),
  )];

  const failuresResult = retainedSessionIds.length === 0
    ? { rows: [] as Array<{
        session_id: string; request_id_hash: string; page_route: string; method: string;
        endpoint_pattern: string; status: number; action_kind: FailedRequestEvidence['actionKind'];
        action_selector: string | null; action_link: FailedRequestEvidence['actionLink'];
        occurred_at: Date | string; rule_version: number;
      }> }
    : await pool.query<{
        session_id: string; request_id_hash: string; page_route: string; method: string;
        endpoint_pattern: string; status: number; action_kind: FailedRequestEvidence['actionKind'];
        action_selector: string | null; action_link: FailedRequestEvidence['actionLink'];
        occurred_at: Date | string; rule_version: number;
      }>(
        `SELECT f.session_id, f.request_id_hash, f.page_route, f.method,
                f.endpoint_pattern, f.status, f.action_kind, f.action_selector,
                f.action_link, f.occurred_at, f.rule_version
           FROM session_request_failures f
          WHERE f.project_id=$1 AND f.session_id=ANY($2::text[])
            AND f.rule_version=(
              SELECT analysis.rule_version FROM session_analysis analysis
               WHERE analysis.project_id=f.project_id AND analysis.session_id=f.session_id)
          ORDER BY f.occurred_at DESC, f.request_id_hash
          LIMIT $3`,
        [projectId, retainedSessionIds, MAX_FAILED_REQUESTS],
      );

  const rollupsResult = retainedSessionIds.length === 0
    ? { rows: [] as Array<{
        session_id: string; page_route: string; method: string; endpoint_pattern: string;
        status_class: number; occurrence_count: number; rule_version: number;
      }> }
    : await pool.query<{
        session_id: string; page_route: string; method: string; endpoint_pattern: string;
        status_class: number; occurrence_count: number; rule_version: number;
      }>(
        `SELECT w.session_id, w.page_route, w.method, w.endpoint_pattern,
                w.status_class, w.occurrence_count, w.rule_version
           FROM session_write_rollups w
          WHERE w.project_id=$1 AND w.session_id=ANY($2::text[])
            AND w.rule_version=(
              SELECT analysis.rule_version FROM session_analysis analysis
               WHERE analysis.project_id=w.project_id AND analysis.session_id=w.session_id)
          ORDER BY w.occurrence_count DESC, w.session_id, w.page_route, w.method
          LIMIT $3`,
        [projectId, retainedSessionIds, MAX_WRITE_ROLLUPS],
      );

  const failedRequests = failuresResult.rows.map((row): FailedRequestEvidence => ({
    sessionId: row.session_id,
    requestIdHash: row.request_id_hash,
    pageRoute: row.page_route,
    method: row.method,
    endpointPattern: row.endpoint_pattern,
    status: row.status,
    actionKind: row.action_kind,
    actionSelector: row.action_selector,
    actionLink: row.action_link,
    occurredAt: iso(row.occurred_at),
    ruleVersion: row.rule_version,
  }));
  const writeRollups = rollupsResult.rows.map((row): WriteRollupEvidence => ({
    sessionId: row.session_id,
    pageRoute: row.page_route,
    method: row.method,
    endpointPattern: row.endpoint_pattern,
    statusClass: row.status_class,
    occurrenceCount: row.occurrence_count,
    ruleVersion: row.rule_version,
  }));

  const routes = [...new Set([
    ...anchors.map((anchor) => anchor.route_url ? normalizePageUrl(anchor.route_url) : ''),
    ...failedRequests.map((failure) => failure.pageRoute),
    ...writeRollups.map((rollup) => rollup.pageRoute),
  ].filter((route) => route !== ''))];

  const productContextResult = routes.length === 0
    ? { rows: [] as Array<{
        pattern: string; name: string; purpose: string; tier: string; actions: string[];
        client_refs: string[]; server_refs: string[]; observed_requests: string[];
        audience: string; confidence: number; commit_sha: string | null;
        prompt_version: number | null; model: string | null; source: string;
      }> }
    : await pool.query<{
        pattern: string; name: string; purpose: string; tier: string; actions: string[];
        client_refs: string[]; server_refs: string[]; observed_requests: string[];
        audience: string; confidence: number; commit_sha: string | null;
        prompt_version: number | null; model: string | null; source: string;
      }>(
        `SELECT pattern, name, purpose, tier, actions, client_refs, server_refs,
                observed_requests, audience, confidence, commit_sha,
                prompt_version, model, source
           FROM route_map
          WHERE project_id=$1 AND pattern=ANY($2::text[])
          ORDER BY pattern`,
        [projectId, routes],
      );
  const productContext = productContextResult.rows.map((row): ProductContextEvidence => ({
    route: row.pattern,
    name: row.name,
    purpose: row.purpose,
    tier: row.tier,
    actions: row.actions,
    clientRefs: row.client_refs,
    serverRefs: row.server_refs,
    observedRequests: row.observed_requests,
    audience: row.audience,
    confidence: row.confidence,
    commitSha: row.commit_sha,
    promptVersion: row.prompt_version,
    model: row.model,
    source: row.source,
  }));

  const affectedResult = await pool.query<{ affected_units: string | number }>(
    `WITH episode_events AS (
       -- Same affected-unit definition as the Go filter (evaluate.go): only
       -- in-scope events count. A divergent count here feeds evaluated_units,
       -- and the dispatcher's regrowth gate compares it against Go's in-scope
       -- count, so a superset count silences re-reviews permanently.
       SELECT e.end_user_id, e.session_id
         FROM error_events e
         JOIN error_event_identities i
           ON i.event_id=e.id AND i.project_id=e.project_id
         JOIN projects p ON p.id=i.project_id
         LEFT JOIN project_action_environments pae
           ON pae.project_id=e.project_id AND pae.environment_id=e.environment_id
        WHERE i.project_id=$1 AND i.episode_id=$2
          AND (NOT p.action_scope_enabled OR pae.environment_id IS NOT NULL)
          AND e.created_at > now() - interval '7 days'
     ), anonymous_sessions AS (
       SELECT session_id FROM episode_events
        WHERE session_id IS NOT NULL
        GROUP BY session_id
       HAVING bool_and(end_user_id IS NULL)
     )
     SELECT
       (SELECT count(DISTINCT end_user_id) FROM episode_events WHERE end_user_id IS NOT NULL)
       + (SELECT count(*) FROM anonymous_sessions) AS affected_units`,
    [projectId, episodeId],
  );
  const affectedUnits = Number(affectedResult.rows[0]?.affected_units ?? 0);

  const currentIssueResult = await pool.query<{ canonical_issue_id: string }>(
    `SELECT canonical_issue_id FROM issue_episodes WHERE project_id=$1 AND id=$2`,
    [projectId, episodeId],
  );
  const currentIssueId = currentIssueResult.rows[0]?.canonical_issue_id;
  if (!currentIssueId) throw new Error(`episode ${episodeId} not found in project ${projectId}`);

  const relatedResult = routes.length === 0
    ? { rows: [] as Array<{ issue_id: string; title: string; route: string }> }
    : await pool.query<{ issue_id: string; title: string; route: string }>(
        `SELECT g.id AS issue_id, g.title,
                COALESCE(NULLIF(regexp_replace(g.page_url_normalized, '^https?://[^/]*', '', 'i'), ''), '/') AS route
           FROM error_groups g
          WHERE g.project_id=$1 AND g.id<>$2
            AND g.status NOT IN ('resolved','merged','archived')
            AND COALESCE(NULLIF(regexp_replace(g.page_url_normalized, '^https?://[^/]*', '', 'i'), ''), '/')
                =ANY($3::text[])
          ORDER BY g.last_seen DESC, g.id
          LIMIT $4`,
        [projectId, currentIssueId, routes, MAX_RELATED_CANDIDATES],
      );

  const status = threshold.resolution_status ?? 'missing';
  return {
    frames: {
      sourceEventId: threshold.event_id,
      status,
      resolverVersion: threshold.resolver_version,
      envelope: envelopeV2(threshold.envelope),
      commitSha: threshold.commit_sha,
    },
    failedRequests,
    writeRollups,
    productContext,
    replayPointers: anchors
      .filter((anchor): anchor is AnchorRow & { session_id: string; retained_session_id: string } => (
        anchor.session_id !== null && anchor.retained_session_id !== null
      ))
      .map((anchor) => ({
        anchorKind: anchor.anchor_kind,
        eventId: anchor.event_id,
        sessionId: anchor.session_id,
        anchorMs: new Date(anchor.event_at).getTime(),
      })),
    availability: {
      recording: recordingAvailability(anchors),
      sourceMap: status,
    },
    affectedUnits,
    relatedCandidates: relatedResult.rows.map((row) => ({
      issueId: row.issue_id,
      title: row.title,
      route: row.route,
    })),
  };
}
