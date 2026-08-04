/**
 * E2E test helpers: DB seeding, API client, and polling utilities.
 *
 * Environment variables:
 *   DATABASE_URL     — Postgres connection string (required)
 *   INGESTION_URL    — Base URL for ingestion API (default: http://localhost:8082)
 */

import pg from 'pg';
import crypto from 'node:crypto';

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Credential types
// ---------------------------------------------------------------------------

// Credentials are all strings on the wire, which is how an ingest key ended
// up in an Authorization header on #243 without the compiler noticing.
// Branding them costs nothing at runtime and makes that swap a type error.
export type IngestKey = string & { readonly __credential: 'ingest' };
export type SourceMapKey = string & { readonly __credential: 'sourcemap' };
export type UserSession = string & { readonly __credential: 'session' };

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export function getConfig() {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for E2E tests');
  }
  return {
    databaseUrl,
    ingestionUrl: process.env['INGESTION_URL'] ?? 'http://localhost:8082',
  };
}

// ---------------------------------------------------------------------------
// DB Pool (shared across test files)
// ---------------------------------------------------------------------------

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const { databaseUrl } = getConfig();
    pool = new Pool({ connectionString: databaseUrl });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// ---------------------------------------------------------------------------
// Tenant seeding
// ---------------------------------------------------------------------------

export interface TestTenant {
  orgId: string;
  projectId: string;
  environmentId: string;
  ingestKey: IngestKey; // raw key for X-API-Key header, scope 'ingest'
  sourceMapKey: SourceMapKey; // raw key for X-API-Key header, scope 'sourcemaps'
  revokedKey: IngestKey; // an ingest key whose revoked_at is already set
  userSession: UserSession; // JWT for session-authenticated read endpoints
}

type ProjectKeyScope = 'ingest' | 'sourcemaps';

/**
 * The origin a minted source-map key routes uploads to.
 *
 * A source-map key carries its own destination, so the E2E stack's own URL has
 * to be sealed into every key this harness mints. The decoder only accepts a
 * canonical origin; a trailing slash is the one deviation a hand-set
 * INGESTION_URL plausibly carries, so drop it here rather than mint keys the
 * plugin and the server both refuse.
 */
function sealedIngestOrigin(): string {
  return getConfig().ingestionUrl.replace(/\/+$/, '');
}

/**
 * Builds the trailing payload segment of a source-map key: unpadded base64url
 * over `{v, iat, url}`, byte-for-byte what `db.EncodeSKPayload` produces.
 *
 * `iat` is never compared by a test, but it must still be a Z-suffixed RFC 3339
 * timestamp with no fractional seconds or the decoder rejects the whole key.
 */
function encodeSourceMapPayload(canonicalUrl: string): string {
  const iat = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const body = JSON.stringify({ v: 1, iat, url: canonicalUrl });
  return Buffer.from(body, 'utf8').toString('base64url');
}

/**
 * Inserts a project-scoped API key row and returns its raw wire form plus
 * the key_id (needed by callers that revoke the key right after minting it).
 *
 * Generic over the credential brand so both seedProjectIngestKey and
 * seedProjectSourceMapKey share one place where a freshly generated string
 * legitimately becomes a branded credential, instead of each carrying its
 * own cast.
 */
async function mintProjectKey<T extends string>(
  db: pg.Pool,
  projectId: string,
  scope: ProjectKeyScope,
  tokenPrefix: string,
  label: string,
): Promise<{ keyId: string; key: T }> {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  const keyId = Array.from(
    crypto.randomBytes(26),
    (byte) => alphabet[byte % alphabet.length],
  ).join('');
  const secret = crypto.randomBytes(32).toString('base64url');
  const secretHash = crypto.createHash('sha256').update(secret).digest('hex');

  await db.query(
    `INSERT INTO project_api_keys
       (key_id, project_id, scope, token_prefix, secret_hash, label)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [keyId, projectId, scope, tokenPrefix, secretHash, label],
  );

  // Boundary: the key is random bytes we just inserted under `scope`, so its
  // wire string is known by construction to be the credential T names. This
  // is where an unbranded value legitimately becomes a branded credential.
  // Source-map keys additionally carry the upload origin; only the secret is
  // hashed, so the payload never touches the row inserted above.
  const bare = `${tokenPrefix}_${keyId}_${secret}`;
  const key = (scope === 'sourcemaps'
    ? `${bare}_${encodeSourceMapPayload(sealedIngestOrigin())}`
    : bare) as T;
  return { keyId, key };
}

async function seedProjectIngestKey(
  db: pg.Pool,
  projectId: string,
  label: string,
): Promise<IngestKey> {
  const { key } = await mintProjectKey<IngestKey>(db, projectId, 'ingest', 'opslane_pk', label);
  return key;
}

async function seedProjectSourceMapKey(
  db: pg.Pool,
  projectId: string,
  label: string,
): Promise<SourceMapKey> {
  const { key } = await mintProjectKey<SourceMapKey>(db, projectId, 'sourcemaps', 'opslane_sk', label);
  return key;
}

/** Mints an ingest key and revokes it immediately, for testing rejection of revoked credentials. */
async function seedRevokedIngestKey(
  db: pg.Pool,
  projectId: string,
  label: string,
): Promise<IngestKey> {
  const { keyId, key } = await mintProjectKey<IngestKey>(db, projectId, 'ingest', 'opslane_pk', label);
  await db.query(`UPDATE project_api_keys SET revoked_at = now() WHERE key_id = $1`, [keyId]);
  return key;
}

/**
 * Creates a full tenant hierarchy with an ingest key, a source-map key, a
 * revoked key, and a session user. Uses a unique suffix to avoid collisions
 * between test runs.
 */
export async function seedTenant(
  githubRepo = 'test-org/test-repo'
): Promise<TestTenant> {
  const db = getPool();
  const suffix = crypto.randomUUID().slice(0, 8);

  // Create org
  const orgResult = await db.query<{ id: string }>(
    `INSERT INTO orgs (name) VALUES ($1) RETURNING id`,
    [`e2e-org-${suffix}`]
  );
  const orgId = orgResult.rows[0]!.id;

  // Create project
  const projectResult = await db.query<{ id: string }>(
    `INSERT INTO projects (org_id, name, github_repo) VALUES ($1, $2, $3) RETURNING id`,
    [orgId, `e2e-project-${suffix}`, githubRepo]
  );
  const projectId = projectResult.rows[0]!.id;

  // Create environment
  const envResult = await db.query<{ id: string }>(
    `INSERT INTO environments (project_id, name) VALUES ($1, $2) RETURNING id`,
    [projectId, 'production']
  );
  const environmentId = envResult.rows[0]!.id;

  const ingestKey = await seedProjectIngestKey(db, projectId, 'e2e tenant ingest');
  const sourceMapKey = await seedProjectSourceMapKey(db, projectId, 'e2e tenant sourcemap');
  const revokedKey = await seedRevokedIngestKey(db, projectId, 'e2e tenant revoked');
  // Boundary: seedUserWithJWT signs a plain JWT string; this tenant's use of
  // it is what makes it a session credential, so this is where it becomes a
  // branded UserSession. (seedUserWithJWT itself stays untyped: its `jwt` is
  // also consumed directly, unbranded, by tests that only need a bearer
  // token and never touch TestTenant.)
  const { jwt } = await seedUserWithJWT(orgId);
  const userSession = jwt as UserSession;

  return { orgId, projectId, environmentId, ingestKey, sourceMapKey, revokedKey, userSession };
}

// ---------------------------------------------------------------------------
// Direct DB seeding for error groups (bypasses ingestion for contract tests)
// ---------------------------------------------------------------------------

export interface SeedGroupOptions {
  projectId: string;
  environmentId: string;
  status: string;
  title?: string;
  fingerprint?: string;
  reasonCode?: string;
  reasonMessage?: string;
  remediation?: string;
  confidence?: string;
  prUrl?: string;
  prNumber?: number;
  candidateDiff?: string;
  verificationEvidence?: Record<string, unknown>;
}

/**
 * Seeds an error event + error group + job directly in DB.
 * Returns the group ID.
 */
export async function seedErrorGroup(opts: SeedGroupOptions): Promise<string> {
  const db = getPool();
  const suffix = crypto.randomUUID().slice(0, 8);
  const fingerprint = opts.fingerprint ?? `fp-${suffix}`;
  const title = opts.title ?? `Test Error ${suffix}`;
  const now = new Date().toISOString();

  // Insert error event
  const eventResult = await db.query<{ id: string }>(
    `INSERT INTO error_events (project_id, environment_id, timestamp, error_type, error_message, stack_trace_raw)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [opts.projectId, opts.environmentId, now, 'TypeError', title, 'Error\n  at test.js:1:1']
  );
  const eventId = eventResult.rows[0]!.id;

  // Insert error group
  const groupResult = await db.query<{ id: string }>(
    `INSERT INTO error_groups (
       project_id, fingerprint, title, first_seen, last_seen,
       occurrence_count, affected_users_count, status, sample_event_id,
       reason_code, reason_message, remediation,
       confidence, pr_url, pr_number, candidate_diff, verification_evidence
     ) VALUES ($1, $2, $3, $4, $4, 1, 1, $5::error_group_status, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
     RETURNING id`,
    [
      opts.projectId, fingerprint, title, now, opts.status, eventId,
      opts.reasonCode ?? null,
      opts.reasonMessage ?? null,
      opts.remediation ?? null,
      opts.confidence ?? null,
      opts.prUrl ?? null,
      opts.prNumber ?? null,
      opts.candidateDiff ?? null,
      opts.verificationEvidence === undefined
        ? null
        : JSON.stringify(opts.verificationEvidence),
    ]
  );
  const groupId = groupResult.rows[0]!.id;

  // Link event to group
  await db.query(
    `UPDATE error_events SET error_group_id = $1 WHERE id = $2`,
    [groupId, eventId]
  );

  return groupId;
}

// ---------------------------------------------------------------------------
// API Client
// ---------------------------------------------------------------------------

export interface Incident {
  id: string;
  project_id: string;
  fingerprint: string;
  title: string;
  status: string;
  first_seen: string;
  last_seen: string;
  occurrence_count: number;
  affected_users_count: number;
  confidence?: string;
  pr_url?: string;
  reason?: {
    reason_code: string;
    reason_message: string;
    remediation: string;
  };
  candidate_diff?: string;
  verification_evidence?: Record<string, unknown>;
}

/**
 * POST an error event to the ingestion API.
 */
export async function postEvent(
  ingestKey: IngestKey,
  payload: Record<string, unknown>
): Promise<Response> {
  const { ingestionUrl } = getConfig();
  return fetch(`${ingestionUrl}/api/v1/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': ingestKey,
    },
    body: JSON.stringify(payload),
  });
}

/**
 * GET all incidents for a project.
 */
export async function listIncidents(
  userSession: UserSession,
  projectId: string,
  environmentId?: string,
): Promise<Incident[]> {
  const { ingestionUrl } = getConfig();
  const query = environmentId
    ? `?environment_id=${encodeURIComponent(environmentId)}`
    : '';
  const res = await fetch(
    `${ingestionUrl}/api/v1/projects/${projectId}/incidents${query}`,
    { headers: { Authorization: `Bearer ${userSession}` } }
  );
  if (!res.ok) {
    throw new Error(`listIncidents failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<Incident[]>;
}

export interface SessionSummary {
  id: string;
  started_at: string;
  status: string;
  page_url?: string;
}

/** GET sessions for a project, optionally filtered by environment. */
export async function listSessions(
  userSession: UserSession,
  projectId: string,
  environmentId?: string,
): Promise<SessionSummary[]> {
  const { ingestionUrl } = getConfig();
  const query = environmentId
    ? `?environment_id=${encodeURIComponent(environmentId)}`
    : '';
  const res = await fetch(
    `${ingestionUrl}/api/v1/projects/${projectId}/sessions${query}`,
    { headers: { Authorization: `Bearer ${userSession}` } },
  );
  if (!res.ok) {
    throw new Error(`listSessions failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json() as { sessions: SessionSummary[] };
  return body.sessions;
}

/**
 * GET a single incident by ID.
 */
export async function getIncident(
  userSession: UserSession,
  projectId: string,
  incidentId: string
): Promise<Incident> {
  const { ingestionUrl } = getConfig();
  const res = await fetch(
    `${ingestionUrl}/api/v1/projects/${projectId}/incidents/${incidentId}`,
    { headers: { Authorization: `Bearer ${userSession}` } }
  );
  if (!res.ok) {
    throw new Error(`getIncident failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<Incident>;
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

/**
 * Polls an incident until its status matches one of the given terminal statuses,
 * or the timeout expires.
 */
export async function pollUntilTerminal(
  userSession: UserSession,
  projectId: string,
  incidentId: string,
  terminalStatuses: string[],
  timeoutMs = 45_000,
  intervalMs = 2_000
): Promise<Incident> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const incident = await getIncident(userSession, projectId, incidentId);
    if (terminalStatuses.includes(incident.status)) {
      return incident;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  // One last try
  const incident = await getIncident(userSession, projectId, incidentId);
  if (terminalStatuses.includes(incident.status)) {
    return incident;
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for incident ${incidentId} to reach terminal status. Last status: ${incident.status}`
  );
}

// ---------------------------------------------------------------------------
// Session auth (JWT)
// ---------------------------------------------------------------------------

const DEFAULT_JWT_SECRET = 'opslane-dev-jwt-secret-key-minimum-32-bytes-long';

/**
 * Generate a session JWT for test API calls.
 * Uses the same HMAC-SHA256 algorithm as the Go auth package.
 */
export function generateTestJWT(userId: string, orgId: string, email = 'test@opslane.dev'): string {
  const secret = process.env['JWT_SECRET'] ?? DEFAULT_JWT_SECRET;
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: userId,
    org_id: orgId,
    email,
    iat: now,
    exp: now + 3600,
  })).toString('base64url');

  const signingInput = `${header}.${payload}`;
  const sig = crypto.createHmac('sha256', secret).update(signingInput).digest().toString('base64url');

  return `${signingInput}.${sig}`;
}

/**
 * Creates a user in the DB and returns a JWT for session-authenticated endpoints.
 */
export async function seedUserWithJWT(orgId: string): Promise<{ userId: string; jwt: string }> {
  const db = getPool();
  const suffix = crypto.randomUUID().slice(0, 8);
  const email = `e2e-user-${suffix}@opslane.dev`;

  const userResult = await db.query<{ id: string }>(
    `INSERT INTO users (org_id, email, name, password_hash) VALUES ($1, $2, $3, $4) RETURNING id`,
    [orgId, email, `E2E User ${suffix}`, 'not-a-real-hash']
  );
  const userId = userResult.rows[0]!.id;
  const jwt = generateTestJWT(userId, orgId, email);

  return { userId, jwt };
}

// ---------------------------------------------------------------------------
// Session / friction helpers (browser smoke)
// ---------------------------------------------------------------------------

/** Polls until the project has a session (created by SDK /sessions/init). */
export async function pollSessionForProject(
  projectId: string,
  timeoutMs = 30_000
): Promise<string> {
  const db = getPool();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM sessions WHERE project_id = $1 ORDER BY started_at DESC LIMIT 1`,
      [projectId]
    );
    if (rows[0]) return rows[0].id;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`No session appeared for project ${projectId} within ${timeoutMs}ms`);
}

/** Polls until at least one chunk for the session is scrubbed (analyzable).
 * Scrubber cadence: eligible 30s after upload, swept every SCRUB_INTERVAL_SECONDS
 * (15s by default, 1s in CI). Call makeChunksScrubbable first to skip the grace. */
export async function pollScrubbedChunk(
  sessionId: string,
  timeoutMs = 120_000
): Promise<void> {
  const db = getPool();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await db.query(
      `SELECT 1 FROM session_chunks WHERE session_id = $1 AND scrubbed_at IS NOT NULL LIMIT 1`,
      [sessionId]
    );
    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`No scrubbed chunk for session ${sessionId} within ${timeoutMs}ms`);
}

/** Batch 3 gap: the product does not yet auto-create session_analysis jobs.
 * Delete this helper when automatic scheduling lands. */
export async function insertSessionAnalysisJob(
  projectId: string,
  sessionId: string
): Promise<void> {
  const db = getPool();
  await db.query(
    `INSERT INTO error_group_jobs (project_id, session_id, job_type, status, triggered_by)
     VALUES ($1, $2, 'session_analysis', 'pending', 'auto')`,
    [projectId, sessionId]
  );
}

/** Polls sessions.status until it reaches one of the given values. */
export async function pollSessionStatus(
  sessionId: string,
  statuses: string[],
  timeoutMs = 60_000
): Promise<string> {
  const db = getPool();
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const { rows } = await db.query<{ status: string }>(
      `SELECT status FROM sessions WHERE id = $1`,
      [sessionId]
    );
    last = rows[0]?.status ?? '(missing)';
    if (statuses.includes(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Session ${sessionId} stuck at '${last}' after ${timeoutMs}ms`);
}

export interface FrictionSignalRow {
  signal_type: string;
  element_selector: string | null;
  occurrence_count: number;
}

/** Active (non-retracted, non-superseded) friction signals for a session. */
export async function getActiveFrictionSignals(
  sessionId: string
): Promise<FrictionSignalRow[]> {
  const db = getPool();
  const { rows } = await db.query<FrictionSignalRow>(
    `SELECT signal_type, element_selector, occurrence_count
       FROM friction_signals
      WHERE session_id = $1 AND retracted_at IS NULL AND superseded_by IS NULL`,
    [sessionId]
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Removes all test data created by seedTenant (cascading through FKs).
 * Call in afterAll to clean up.
 */
export async function cleanupTenant(orgId: string): Promise<void> {
  const db = getPool();

  // Delete in dependency order (or rely on CASCADE if configured)
  // Since we don't have CASCADE, delete manually in reverse order

  // oauth_login_states.initiating_user_id references users with no ON DELETE
  // (migration 024), so clear login states before the users they point at.
  await db.query(
    `DELETE FROM oauth_login_states WHERE initiating_user_id IN (SELECT id FROM users WHERE org_id = $1)`,
    [orgId]
  );

  // Users
  await db.query(
    `DELETE FROM users WHERE org_id = $1`,
    [orgId]
  );

  await db.query(
    `DELETE FROM error_group_jobs WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
    [orgId]
  );
  // Sessions cascade to session_chunks and friction_signals.
  await db.query(
    `DELETE FROM sessions WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
    [orgId]
  );
  await db.query(
    `DELETE FROM session_replay_artifacts WHERE replay_id IN (
       SELECT sr.id FROM session_replays sr JOIN projects p ON sr.project_id = p.id WHERE p.org_id = $1
     )`,
    [orgId]
  );
  await db.query(
    `DELETE FROM session_replays WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
    [orgId]
  );
  await db.query(
    `DELETE FROM error_events WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
    [orgId]
  );
  // Events with context.user create affected-user junction rows that block
  // the error_groups delete (no cascade).
  await db.query(
    `DELETE FROM error_group_affected_users WHERE error_group_id IN (
       SELECT eg.id FROM error_groups eg JOIN projects p ON eg.project_id = p.id WHERE p.org_id = $1
     )`,
    [orgId]
  );
  await db.query(
    `DELETE FROM error_groups WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
    [orgId]
  );
  // Identified sessions/events create end_users rows that block the projects
  // delete below (observed in CI teardown after the friction gate landed).
  await db.query(
    `DELETE FROM end_users WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
    [orgId]
  );
  // Notification destinations and outbox events reference projects without
  // cascade; outbound_deliveries cascades from both.
  await db.query(
    `DELETE FROM notification_destinations WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
    [orgId]
  );
  await db.query(
    `DELETE FROM outbound_events WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
    [orgId]
  );
  await db.query(
    `DELETE FROM project_api_keys WHERE project_id IN (
       SELECT id FROM projects WHERE org_id = $1
     )`,
    [orgId]
  );
  await db.query(
    `DELETE FROM environments WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
    [orgId]
  );
  await db.query(`DELETE FROM projects WHERE org_id = $1`, [orgId]);
  await db.query(`DELETE FROM orgs WHERE id = $1`, [orgId]);
}

// ---------------------------------------------------------------------------
// Session chunk helpers (Batch 4 friction e2e)
// ---------------------------------------------------------------------------

export interface SessionUser {
  id: string;
  email?: string;
}

/** Registers a recording session, optionally bound to an identified user. */
export async function initSession(
  apiKey: string,
  sessionId: string,
  user?: SessionUser,
  pageUrl = 'https://app.example.com/checkout',
  environment?: string,
): Promise<void> {
  const { ingestionUrl } = getConfig();
  const res = await fetch(`${ingestionUrl}/api/v1/sessions/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
    body: JSON.stringify({
      session_id: sessionId,
      started_at: new Date().toISOString(),
      page_url: pageUrl,
      ...(environment ? { environment } : {}),
      ...(user ? { user } : {}),
    }),
  });
  if (res.status !== 200) {
    throw new Error(`session init failed: ${res.status} ${await res.text()}`);
  }
}

/** Uploads one gzipped chunk through ingestion's single-call storage path. */
export async function uploadChunk(
  apiKey: string,
  sessionId: string,
  seq: number,
  envelope: { events: unknown[]; meta?: Record<string, unknown> }
): Promise<void> {
  const { ingestionUrl } = getConfig();
  const { gzipSync } = await import('node:zlib');
  const compressed = gzipSync(JSON.stringify(envelope));

  const upload = await fetch(
    `${ingestionUrl}/api/v1/sessions/${sessionId}/chunks/${seq}?has_full_snapshot=1`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/gzip', 'X-API-Key': apiKey },
      body: compressed,
    },
  );
  if (!upload.ok) {
    throw new Error(`chunk upload failed: ${upload.status} ${await upload.text()}`);
  }
}

/**
 * Makes a test's own freshly-committed chunks eligible for the scrubber now.
 *
 * Production retains a 30s eligibility grace in ClaimUnscrubbedChunks. Chunk
 * uploads are no longer presigned, so the grace is no longer load-bearing
 * against a replayed upload replacing already-scrubbed bytes; shortening it is
 * a separate privacy-timing decision. Tests fast-forward their own fixtures so
 * they do not wait out that production interval.
 *
 * Scoped to one session id, so it can never touch a concurrently running
 * suite's rows. Shifts uploaded_at relatively, so ordering within a batch (the
 * claim query's ORDER BY uploaded_at) is preserved.
 *
 * Waits for the chunk to be committed first: callers that upload through a real
 * browser SDK (friction-smoke) have no synchronous upload to await.
 */
export async function makeChunksScrubbable(
  sessionId: string,
  timeoutMs = 60_000
): Promise<void> {
  const db = getPool();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await db.query(
      `UPDATE session_chunks
          SET uploaded_at = uploaded_at - interval '1 hour'
        WHERE session_id = $1
          AND uploaded_at IS NOT NULL
          AND uploaded_at > now() - interval '1 minute'`,
      [sessionId]
    );
    if ((res.rowCount ?? 0) > 0) return;
    if (Date.now() > deadline) {
      throw new Error(`no committed chunk for ${sessionId} within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Waits until the ingestion scrubber has made the session's chunks readable. */
export async function waitForScrubbedChunks(
  sessionId: string,
  expected: number,
  timeoutMs = 60_000
): Promise<void> {
  const db = getPool();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM session_chunks
       WHERE session_id = $1 AND scrubbed_at IS NOT NULL`,
      [sessionId]
    );
    if (Number(res.rows[0]!.n) >= expected) return;
    if (Date.now() > deadline) {
      throw new Error(`chunks for ${sessionId} not scrubbed within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Creates an additional environment and project-scoped ingest key. */
export async function seedEnvironment(
  projectId: string,
  name: string
): Promise<{ environmentId: string; ingestKey: IngestKey }> {
  const db = getPool();
  const envResult = await db.query<{ id: string }>(
    `INSERT INTO environments (project_id, name) VALUES ($1, $2) RETURNING id`,
    [projectId, name]
  );
  const environmentId = envResult.rows[0]!.id;
  const ingestKey = await seedProjectIngestKey(db, projectId, `e2e ${name} ingest`);
  return { environmentId, ingestKey };
}
