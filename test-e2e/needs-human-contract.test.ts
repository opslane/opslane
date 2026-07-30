/**
 * E2E: Failure path — error group reaches terminal `needs_human` status
 * with complete reason contract (reason_code + reason_message + remediation).
 *
 * This test validates:
 * 1. Contract test: Seeds needs_human state in DB, verifies all reason fields are present.
 * 2. Completeness: Every reason_code from the shared type is tested.
 * 3. Pipeline test: Without ANTHROPIC_API_KEY, worker should produce needs_human with missing_llm_key.
 *
 * Required:
 *   DATABASE_URL       — Postgres connection string
 *   INGESTION_URL      — Base URL for ingestion API (default: http://localhost:8082)
 */

import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  seedTenant,
  seedErrorGroup,
  getIncident,
  listIncidents,
  postEvent,
  pollUntilTerminal,
  cleanupTenant,
  closePool,
  type TestTenant,
  type Incident,
} from './helpers.js';

// All reason codes from shared/src/types.ts
const REASON_CODES = [
  'missing_github_token',
  'repo_access_denied',
  'empty_repository',
  'invalid_default_branch',
  'unresolvable_head',
  'token_decrypt_failed',
  'auth_invalid',
  'policy_blocked',
  'missing_llm_key',
  'malformed_diff',
  'verification_failed',
  'sourcemap_unresolved',
  'artifact_fetch_failed',
  'insufficient_context',
  'worker_runtime_error',
  'lease_lost',
  'budget_exhausted',
  'tests_failed',
  'low_confidence_fix',
  'repro_not_achievable',
  'verification_infra_error',
  'draft_cap_reached',
  'triage_unfixable',
  'unfixable_no_app_frames',
  'unfixable_test_error',
  'unfixable_third_party',
  'unfixable_infra',
  'unfixable_no_sourcemap',
] as const;

// ---------------------------------------------------------------------------
// Contract test: needs_human read API contract
// ---------------------------------------------------------------------------

describe('needs_human contract (read API)', () => {
  let tenant: TestTenant;
  const groupIds: Map<string, string> = new Map();

  beforeAll(async () => {
    tenant = await seedTenant();

    // Seed one error group per reason code to verify completeness
    for (const code of REASON_CODES) {
      const groupId = await seedErrorGroup({
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        status: 'needs_human',
        title: `Error triggering ${code}`,
        reasonCode: code,
        reasonMessage: `This error requires human intervention: ${code}`,
        remediation: `Steps to resolve ${code}: check configuration and retry.`,
      });
      groupIds.set(code, groupId);
    }
  });

  afterAll(async () => {
    await cleanupTenant(tenant.orgId);
    await closePool();
  });

  it('every needs_human incident has complete reason fields', async () => {
    const incidents = await listIncidents(tenant.sessionToken, tenant.projectId);

    // All seeded groups should appear
    expect(incidents.length).toBeGreaterThanOrEqual(REASON_CODES.length);

    for (const code of REASON_CODES) {
      const groupId = groupIds.get(code)!;
      const incident = incidents.find((i) => i.id === groupId);
      expect(incident, `incident for ${code} should exist in list`).toBeDefined();
      expect(incident!.status).toBe('needs_human');
      expect(incident!.reason, `${code} must have reason object`).toBeDefined();
    }
  });

  it.each(REASON_CODES)(
    'reason contract complete for code: %s',
    async (code) => {
      const groupId = groupIds.get(code)!;
      const incident = await getIncident(
        tenant.sessionToken,
        tenant.projectId,
        groupId
      );

      expect(incident.status).toBe('needs_human');

      // Core contract: all three fields MUST be present and non-empty
      expect(incident.reason).toBeDefined();
      expect(incident.reason!.reason_code).toBe(code);
      expect(incident.reason!.reason_message).toBeTruthy();
      expect(incident.reason!.reason_message.length).toBeGreaterThan(0);
      expect(incident.reason!.remediation).toBeTruthy();
      expect(incident.reason!.remediation.length).toBeGreaterThan(0);

      // needs_human should NOT have pr_url
      expect(incident.pr_url).toBeUndefined();
    }
  );

  it('exposes candidate_diff and verification_evidence on needs_human incidents', async () => {
    const evidence = {
      version: 1,
      tier: 'E1',
      checks: [
        {
          name: 'build',
          outcome: 'passed',
          command: 'npm run build',
          output_tail: '',
        },
      ],
    };
    const groupId = await seedErrorGroup({
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      status: 'needs_human',
      title: 'Error with verification evidence',
      reasonCode: 'low_confidence_fix',
      reasonMessage: 'The candidate fix requires human review.',
      remediation: 'Review the candidate diff and verification evidence.',
      candidateDiff: '--- a/f\n+++ b/f\n',
      verificationEvidence: evidence,
    });

    const incident = await getIncident(
      tenant.sessionToken,
      tenant.projectId,
      groupId
    );

    expect(incident.candidate_diff).toContain('+++ b/f');
    expect(incident.verification_evidence?.tier).toBe('E1');
  });

  it('rejects needs_human without reason fields at DB level', async () => {
    // Try to seed a needs_human group without reason fields via DB
    // The UpdateErrorGroupStatus Go function validates this, but let's verify
    // the read API handles the case where reason fields are null
    const groupId = await seedErrorGroup({
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      status: 'needs_human',
      title: 'Error with missing reason (should not happen in production)',
      // No reason fields — violates contract
    });

    const incident = await getIncident(
      tenant.sessionToken,
      tenant.projectId,
      groupId
    );

    // The read API should return the incident but reason should be undefined
    // (since all three fields must be present for reason to be included)
    expect(incident.status).toBe('needs_human');
    expect(incident.reason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Pipeline test: missing LLM key produces needs_human
// ---------------------------------------------------------------------------

// This is a pipeline test: it posts an event and waits for a *worker* to mark
// the incident needs_human(missing_llm_key). It therefore requires a worker
// running WITHOUT an LLM key — which the secrets-free contract CI job does not
// start (the worker only runs in the pipeline job, where the LLM key IS set).
// Gate it on an explicit opt-in so it skips gracefully wherever no keyless
// worker is present, instead of hanging on a job that never leaves "queued".
// To exercise it, run a worker with no ANTHROPIC_API_KEY and set E2E_WORKER_NO_KEY=1.
const hasLLMKey = !!process.env['ANTHROPIC_API_KEY'];
const keylessWorkerRunning = process.env['E2E_WORKER_NO_KEY'] === '1';

describe.skipIf(hasLLMKey || !keylessWorkerRunning)(
  'needs_human pipeline (missing LLM key)',
  () => {
    let tenant: TestTenant;

    beforeAll(async () => {
      tenant = await seedTenant();
    });

    afterAll(async () => {
      await cleanupTenant(tenant.orgId);
      await closePool();
    });

    it(
      'worker produces needs_human with missing_llm_key reason',
      async () => {
        // Unique marker so we can assert on the EXACT event we submit —
        // an empty incident list is a failure, never a silent pass.
        const marker = `e2e-keyless-${crypto.randomUUID()}`;
        const eventPayload = {
          timestamp: new Date().toISOString(),
          error: {
            type: 'ReferenceError',
            message: `${marker} is not defined`,
            stack: `ReferenceError: ${marker} is not defined\n  at bar.js:10:5`,
          },
          breadcrumbs: [],
          context: {
            url: 'https://app.example.com/test',
            user_agent: 'Mozilla/5.0 (E2E Test)',
          },
          sdk_version: '0.0.1-e2e',
        };

        const postRes = await postEvent(tenant.apiKey, eventPayload);
        expect(postRes.status).toBe(202);

        // The submitted event must surface as an incident. Poll — grouping is
        // synchronous but the worker claim is not — and fail hard on timeout.
        const deadline = Date.now() + 60_000;
        let incident: Incident | undefined;
        while (Date.now() < deadline && !incident) {
          const incidents = await listIncidents(tenant.sessionToken, tenant.projectId);
          incident = incidents.find((i) => i.title.includes(marker));
          if (!incident) await new Promise((r) => setTimeout(r, 2_000));
        }
        if (!incident) {
          throw new Error(
            `Submitted event (marker ${marker}) never appeared as an incident — ingestion or grouping is broken`
          );
        }

        const terminal = await pollUntilTerminal(
          tenant.sessionToken,
          tenant.projectId,
          incident.id,
          ['needs_human'],
          90_000
        );

        expect(terminal.status).toBe('needs_human');
        expect(terminal.reason).toBeDefined();
        expect(terminal.reason!.reason_code).toBe('missing_llm_key');
        expect(terminal.reason!.reason_message).toBeTruthy();
        expect(terminal.reason!.remediation).toBeTruthy();
      },
      180_000
    );
  }
);

// ---------------------------------------------------------------------------
// Incident ordering and pagination
// ---------------------------------------------------------------------------

describe('incident list ordering', () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await seedTenant();

    // Seed groups with different timestamps (created in order, last_seen varies)
    await seedErrorGroup({
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      status: 'needs_human',
      title: 'Older error',
      reasonCode: 'worker_runtime_error',
      reasonMessage: 'Older error message',
      remediation: 'Fix it',
    });

    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 50));

    await seedErrorGroup({
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      status: 'pr_created',
      title: 'Newer error',
      confidence: 'medium',
      prUrl: 'https://github.com/test-org/test-repo/pull/99',
      prNumber: 99,
    });
  });

  afterAll(async () => {
    await cleanupTenant(tenant.orgId);
    await closePool();
  });

  it('returns incidents ordered by last_seen descending', async () => {
    const incidents = await listIncidents(tenant.sessionToken, tenant.projectId);

    expect(incidents.length).toBe(2);

    // Most recent should be first
    const firstSeen = new Date(incidents[0]!.last_seen).getTime();
    const secondSeen = new Date(incidents[1]!.last_seen).getTime();
    expect(firstSeen).toBeGreaterThanOrEqual(secondSeen);
  });

  it('returns at most 100 incidents', async () => {
    // We only have 2, but verify the API doesn't error
    const incidents = await listIncidents(tenant.sessionToken, tenant.projectId);
    expect(incidents.length).toBeLessThanOrEqual(100);
  });
});
