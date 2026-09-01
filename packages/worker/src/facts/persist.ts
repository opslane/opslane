import { getPool } from '../db.js';
import type { SessionFacts } from '../friction/facts.js';
import type pg from 'pg';

export type VersionedSessionFacts = SessionFacts & { ruleVersion: number };

/**
 * One session's facts are whole-session truth at a rule version. A late chunk
 * or a rule-version bump produces a replacement truth, so every stored row for
 * the session is deleted and rewritten in a single transaction: rows from an
 * older rule version must not linger beside the current set.
 *
 * Routes and endpoint patterns arrive already normalized by the extractor.
 * Normalizing again here is not idempotent for every input and can collapse
 * two distinct extractor keys onto one primary key, so un-normalized input is
 * rejected instead: hosts and query strings do not belong in either table.
 */
function assertNormalized(value: string, field: string): void {
  if (value.includes('://') || value.includes('?')) {
    throw new Error(`${field} must be a normalized path, got a host or query string`);
  }
}
export async function replaceSessionFacts(
  projectId: string,
  sessionId: string,
  facts: VersionedSessionFacts,
  suppliedClient?: pg.PoolClient,
): Promise<void> {
  for (const f of facts.failures) {
    assertNormalized(f.pageRoute, 'failure page_route');
    assertNormalized(f.endpointPattern, 'failure endpoint_pattern');
  }
  for (const r of facts.successes) {
    assertNormalized(r.pageRoute, 'rollup page_route');
    assertNormalized(r.endpointPattern, 'rollup endpoint_pattern');
  }
  const client = suppliedClient ?? await getPool().connect();
  const ownsTransaction = suppliedClient === undefined;
  try {
    if (ownsTransaction) await client.query('BEGIN');
    const session = await client.query(
      `SELECT 1 FROM sessions WHERE project_id=$1 AND id=$2 FOR KEY SHARE`,
      [projectId, sessionId],
    );
    if (session.rowCount === 0) {
      throw new Error(`session ${sessionId} not found in project ${projectId}`);
    }

    await client.query(
      `DELETE FROM session_request_failures WHERE project_id=$1 AND session_id=$2`,
      [projectId, sessionId],
    );
    await client.query(
      `DELETE FROM session_write_rollups WHERE project_id=$1 AND session_id=$2`,
      [projectId, sessionId],
    );

    if (facts.failures.length > 0) {
      await client.query(
        `INSERT INTO session_request_failures
           (project_id, session_id, request_id_hash, page_route, method,
            endpoint_pattern, status, action_kind, action_selector, action_link,
            occurred_at, rule_version)
         SELECT $1, $2, f.request_id_hash, f.page_route, f.method,
                f.endpoint_pattern, f.status, f.action_kind, f.action_selector,
                f.action_link, f.occurred_at, $3
           FROM unnest($4::text[], $5::text[], $6::text[], $7::text[],
                       $8::integer[], $9::text[], $10::text[], $11::text[],
                       $12::timestamptz[])
             AS f(request_id_hash, page_route, method, endpoint_pattern,
                  status, action_kind, action_selector, action_link, occurred_at)`,
        [
          projectId,
          sessionId,
          facts.ruleVersion,
          facts.failures.map((f) => f.requestIdHash),
          facts.failures.map((f) => f.pageRoute),
          facts.failures.map((f) => f.method),
          facts.failures.map((f) => f.endpointPattern),
          facts.failures.map((f) => f.status),
          facts.failures.map((f) => f.actionKind),
          facts.failures.map((f) => f.actionSelector),
          facts.failures.map((f) => f.actionLink),
          facts.failures.map((f) => f.occurredAt),
        ],
      );
    }

    if (facts.successes.length > 0) {
      await client.query(
        `INSERT INTO session_write_rollups
           (project_id, session_id, page_route, method, endpoint_pattern,
            status_class, occurrence_count, rule_version)
         SELECT $1, $2, r.page_route, r.method, r.endpoint_pattern,
                r.status_class, r.occurrence_count, $3
           FROM unnest($4::text[], $5::text[], $6::text[], $7::integer[],
                       $8::integer[])
             AS r(page_route, method, endpoint_pattern, status_class,
                  occurrence_count)`,
        [
          projectId,
          sessionId,
          facts.ruleVersion,
          facts.successes.map((r) => r.pageRoute),
          facts.successes.map((r) => r.method),
          facts.successes.map((r) => r.endpointPattern),
          facts.successes.map((r) => r.statusClass),
          facts.successes.map((r) => r.count),
        ],
      );
    }

    if (ownsTransaction) await client.query('COMMIT');
  } catch (error: unknown) {
    if (ownsTransaction) await client.query('ROLLBACK');
    throw error;
  } finally {
    if (ownsTransaction) client.release();
  }
}
