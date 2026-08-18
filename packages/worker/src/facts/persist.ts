import { getPool } from '../db.js';
import type { SessionFacts } from '../friction/facts.js';
import { normalizePageUrl } from '../friction/urlnorm.js';

export type VersionedSessionFacts = SessionFacts & { ruleVersion: number };

/**
 * One session's facts are whole-session truth at a rule version. A late chunk
 * produces a replacement truth, so the old set is deleted and rewritten in a
 * single transaction.
 */
export async function replaceSessionFacts(
  projectId: string,
  sessionId: string,
  facts: VersionedSessionFacts,
): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const session = await client.query(
      `SELECT 1 FROM sessions WHERE project_id=$1 AND id=$2 FOR KEY SHARE`,
      [projectId, sessionId],
    );
    if (session.rowCount === 0) {
      throw new Error(`session ${sessionId} not found in project ${projectId}`);
    }

    await client.query(
      `DELETE FROM session_request_failures
       WHERE project_id=$1 AND session_id=$2 AND rule_version=$3`,
      [projectId, sessionId, facts.ruleVersion],
    );
    await client.query(
      `DELETE FROM session_write_rollups
       WHERE project_id=$1 AND session_id=$2 AND rule_version=$3`,
      [projectId, sessionId, facts.ruleVersion],
    );

    for (const failure of facts.failures) {
      await client.query(
        `INSERT INTO session_request_failures
           (project_id, session_id, request_id_hash, page_route, method,
            endpoint_pattern, status, action_kind, action_selector, action_link,
            occurred_at, rule_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          projectId,
          sessionId,
          failure.requestIdHash,
          normalizePageUrl(failure.pageRoute),
          failure.method,
          normalizePageUrl(failure.endpointPattern),
          failure.status,
          failure.actionKind,
          failure.actionSelector,
          failure.actionLink,
          failure.occurredAt,
          facts.ruleVersion,
        ],
      );
    }

    for (const rollup of facts.successes) {
      await client.query(
        `INSERT INTO session_write_rollups
           (project_id, session_id, page_route, method, endpoint_pattern,
            status_class, occurrence_count, rule_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          projectId,
          sessionId,
          normalizePageUrl(rollup.pageRoute),
          rollup.method,
          normalizePageUrl(rollup.endpointPattern),
          rollup.statusClass,
          rollup.count,
          facts.ruleVersion,
        ],
      );
    }

    await client.query('COMMIT');
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
