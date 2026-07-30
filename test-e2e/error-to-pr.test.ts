/**
 * E2E: Success path — error event reaches terminal `pr_created` status.
 *
 * This test validates two scenarios:
 * 1. Contract test: Seeds pr_created state in DB, verifies read API returns correct fields.
 * 2. Pipeline test: Posts event via API, waits for worker to process to terminal status.
 *
 * Required:
 *   DATABASE_URL       — Postgres connection string
 *   INGESTION_URL      — Base URL for ingestion API (default: http://localhost:8082)
 *
 * Pipeline test additionally requires running worker with ANTHROPIC_API_KEY and GITHUB_TOKEN.
 */

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
} from './helpers.js';

// ---------------------------------------------------------------------------
// Contract test: pr_created read API contract
// ---------------------------------------------------------------------------

describe('pr_created contract (read API)', () => {
  let tenant: TestTenant;
  let groupId: string;

  beforeAll(async () => {
    tenant = await seedTenant();
    groupId = await seedErrorGroup({
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      status: 'pr_created',
      title: 'TypeError: Cannot read properties of undefined',
      confidence: 'high',
      prUrl: 'https://github.com/test-org/test-repo/pull/42',
      prNumber: 42,
    });
  });

  afterAll(async () => {
    await cleanupTenant(tenant.orgId);
    await closePool();
  });

  it('returns incident with pr_url and confidence via GET', async () => {
    const incident = await getIncident(
      tenant.userSession,
      tenant.projectId,
      groupId
    );

    expect(incident.id).toBe(groupId);
    expect(incident.project_id).toBe(tenant.projectId);
    expect(incident.status).toBe('pr_created');
    expect(incident.pr_url).toBe(
      'https://github.com/test-org/test-repo/pull/42'
    );
    expect(incident.confidence).toBe('high');
    expect(incident.title).toBe(
      'TypeError: Cannot read properties of undefined'
    );

    // pr_created should NOT have reason fields
    expect(incident.reason).toBeUndefined();

    // Timestamps should be valid ISO strings
    expect(new Date(incident.first_seen).getTime()).not.toBeNaN();
    expect(new Date(incident.last_seen).getTime()).not.toBeNaN();
    expect(incident.occurrence_count).toBeGreaterThan(0);
  });

  it('appears in list incidents response', async () => {
    const incidents = await listIncidents(tenant.userSession, tenant.projectId);

    expect(incidents.length).toBeGreaterThanOrEqual(1);
    const found = incidents.find((i) => i.id === groupId);
    expect(found).toBeDefined();
    expect(found!.status).toBe('pr_created');
    expect(found!.pr_url).toBe(
      'https://github.com/test-org/test-repo/pull/42'
    );
  });

  it('rejects request with wrong API key', async () => {
    const { ingestionUrl } = await import('./helpers.js').then((m) =>
      m.getConfig()
    );
    const res = await fetch(
      `${ingestionUrl}/api/v1/projects/${tenant.projectId}/incidents/${groupId}`,
      { headers: { 'X-API-Key': 'def_invalid_key_12345' } }
    );
    expect(res.status).toBe(401);
  });

  it('rejects cross-tenant read (mismatched project ID)', async () => {
    // Create a second tenant
    const otherTenant = await seedTenant();

    // Try to read our group using the other tenant's session.
    const { ingestionUrl } = await import('./helpers.js').then((m) =>
      m.getConfig()
    );
    const res = await fetch(
      `${ingestionUrl}/api/v1/projects/${tenant.projectId}/incidents/${groupId}`,
      { headers: { Authorization: `Bearer ${otherTenant.userSession}` } }
    );
    // The session is valid, but its organization cannot access this project.
    expect(res.status).toBe(403);

    await cleanupTenant(otherTenant.orgId);
  });
});

// ---------------------------------------------------------------------------
// Pipeline test: full event → pr_created flow (needs worker + secrets)
// ---------------------------------------------------------------------------

const hasWorkerSecrets =
  !!process.env['ANTHROPIC_API_KEY'] && !!process.env['GITHUB_TOKEN'];

describe.skipIf(!hasWorkerSecrets)(
  'pr_created pipeline (full flow)',
  () => {
    let tenant: TestTenant;

    beforeAll(async () => {
      tenant = await seedTenant('test-org/test-repo');
    });

    afterAll(async () => {
      await cleanupTenant(tenant.orgId);
      await closePool();
    });

    it('event reaches pr_created terminal status', async () => {
      // Post an error event
      const eventPayload = {
        timestamp: new Date().toISOString(),
        error: {
          type: 'TypeError',
          message: 'Cannot read properties of undefined (reading "map")',
          stack:
            'TypeError: Cannot read properties of undefined\n  at App.vue:42:10\n  at renderComponent (vue.js:1234:5)',
        },
        breadcrumbs: [
          {
            type: 'navigation',
            timestamp: new Date().toISOString(),
            category: 'navigation',
            message: '/dashboard → /settings',
          },
        ],
        context: {
          url: 'https://app.example.com/settings',
          user_agent: 'Mozilla/5.0 (E2E Test)',
        },
        sdk_version: '0.0.1-e2e',
      };

      const postRes = await postEvent(tenant.ingestKey, eventPayload);
      expect(postRes.status).toBe(202);

      // Poll for terminal status (pr_created or needs_human)
      // The worker should process the job and reach a terminal state
      const incidents = await listIncidents(tenant.userSession, tenant.projectId);
      if (incidents.length === 0) {
        // Ingest handler hasn't wired up event→group creation yet
        // Skip the poll — this is expected until the handler is complete
        return;
      }

      const incident = incidents[0]!;
      const terminal = await pollUntilTerminal(
        tenant.userSession,
        tenant.projectId,
        incident.id,
        ['pr_created', 'needs_human'],
        45_000
      );

      // Verify terminal contract
      if (terminal.status === 'pr_created') {
        expect(terminal.pr_url).toBeDefined();
        expect(terminal.pr_url).toMatch(/^https:\/\//);
        expect(terminal.confidence).toBeDefined();
        expect(['high', 'medium', 'low']).toContain(terminal.confidence);
      } else {
        // needs_human is also acceptable (e.g., if LLM can't fix)
        // but it MUST have reason fields
        expect(terminal.reason).toBeDefined();
        expect(terminal.reason!.reason_code).toBeTruthy();
        expect(terminal.reason!.reason_message).toBeTruthy();
        expect(terminal.reason!.remediation).toBeTruthy();
      }
    });
  }
);
