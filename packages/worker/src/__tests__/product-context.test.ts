import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { closePool, type ClaimedJob, upsertProductContextClaims } from '../db.js';
import {
  discoverRepositoryRoutes,
  buildProductContextPrompt,
  groundRouteClaims,
  runProductContext,
} from '../product-context/job.js';
import { parseRouteClaims, routeClaimsTerminalTool } from '../product-context/schema.js';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('product context schema', () => {
  it('accepts grounded claims for discovered routes', () => {
    const claims = parseRouteClaims({ claims: [{
      route: '/assets/:id/edit',
      purpose: 'Edit an asset',
      actions: ['save asset'],
      client_refs: ['src/pages/AssetEdit.vue'],
      server_refs: ['server/assets.ts'],
      audience: 'standard',
      confidence: 0.95,
      evidence_conflicts: [],
    }] }, ['/assets/:id/edit']);

    expect(claims).toEqual([{
      route: '/assets/:id/edit',
      purpose: 'Edit an asset',
      actions: ['save asset'],
      clientRefs: ['src/pages/AssetEdit.vue'],
      serverRefs: ['server/assets.ts'],
      audience: 'standard',
      confidence: 0.95,
      evidenceConflicts: [],
    }]);
    expect(routeClaimsTerminalTool().input_schema).toMatchObject({
      additionalProperties: false,
      required: ['claims'],
    });
  });

  it('rejects routes and fields outside the discovery contract', () => {
    const claim = {
      route: '/made-up', purpose: 'Invented', actions: [], client_refs: ['src/app.ts'],
      server_refs: [], audience: 'standard', confidence: 0.5, evidence_conflicts: [],
    };
    expect(() => parseRouteClaims({ claims: [claim] }, ['/known']))
      .toThrow(/undiscovered route/);
    expect(() => parseRouteClaims({ claims: [{ ...claim, route: '/known', importance: 'high' }] }, ['/known']))
      .toThrow(/unknown field/);
  });

  it('rejects claims whose code references do not exist', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'opslane-product-context-'));
    cleanupPaths.push(repoPath);

    await expect(groundRouteClaims(repoPath, [{
      route: '/assets/:id/edit', purpose: 'Edit an asset', actions: [],
      clientRefs: ['src/pages/Missing.vue'], serverRefs: [], audience: 'standard', confidence: 0.8,
      evidenceConflicts: [],
    }])).rejects.toThrow(/does not exist/);
  });

  it('rejects a citation the repository agent did not read', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'opslane-product-context-'));
    cleanupPaths.push(repoPath);
    await mkdir(join(repoPath, 'src'), { recursive: true });
    await writeFile(join(repoPath, 'src/assets.ts'), 'export const save = () => undefined;');

    await expect(groundRouteClaims(repoPath, [{
      route: '/assets/:id/edit', purpose: 'Edit an asset', actions: [],
      clientRefs: ['src/assets.ts'], serverRefs: [], audience: 'standard', confidence: 0.8,
      evidenceConflicts: [],
    }], [])).rejects.toThrow(/was not read/);
  });

  it('keeps grounded claims and marks missing understanding as unknown', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'opslane-product-context-'));
    cleanupPaths.push(repoPath);
    await mkdir(join(repoPath, 'src'), { recursive: true });
    await writeFile(join(repoPath, 'src/assets.ts'), 'export const save = () => undefined;');

    await expect(groundRouteClaims(repoPath, [{
      route: '/assets/:id/edit', purpose: 'Edit an asset', actions: ['save'],
      clientRefs: ['src/assets.ts'], serverRefs: [], audience: 'standard', confidence: 0.9,
      evidenceConflicts: [],
    }, {
      route: '/internal/debug', purpose: 'Debug internals', actions: [],
      clientRefs: [], serverRefs: [], audience: 'admin', confidence: 0.7,
      evidenceConflicts: [],
    }])).resolves.toEqual([{
      route: '/assets/:id/edit', purpose: 'Edit an asset', actions: ['save'],
      clientRefs: ['src/assets.ts'], serverRefs: [], audience: 'standard', confidence: 0.9,
      evidenceConflicts: [],
    }, {
      route: '/internal/debug', purpose: 'unknown', actions: [],
      clientRefs: [], serverRefs: [], audience: 'unknown', confidence: 0,
      evidenceConflicts: [],
    }]);
  });

  it('persists grounded claims with the inspected commit and keeps omitted routes unknown', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'opslane-product-context-'));
    cleanupPaths.push(repoPath);
    await mkdir(join(repoPath, 'src'), { recursive: true });
    await writeFile(join(repoPath, 'src/assets.ts'), 'export const save = () => undefined;');
    const cleanup = vi.fn(async () => undefined);
    const persist = vi.fn(async () => true);
    const job = {
      id: 'job-1', workerId: 'worker-1', leaseGeneration: '2', projectId: 'project-1',
      jobType: 'product_context', errorGroupId: null, eventId: null, sourceId: null,
      attempts: 0, guidance: null, triggeredBy: 'auto', sessionId: null,
    } satisfies ClaimedJob;

    await runProductContext(job, new AbortController().signal, {
      prepare: async () => ({
        repoPath, commitSha: 'commit-123', cleanup,
        routes: [{ route: '/assets/:id/edit', clientRefs: ['src/assets.ts'], serverRefs: [], declaredRequests: [] },
          { route: '/internal/debug', clientRefs: [], serverRefs: [], declaredRequests: [] }],
      }),
      askModel: async () => ({
        raw: { claims: [{
          route: '/assets/:id/edit', purpose: 'Edit an asset', actions: ['save'],
          client_refs: ['src/assets.ts'], server_refs: [], audience: 'standard', confidence: 0.9,
          evidence_conflicts: [],
        }] },
        usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
        costUsd: 0.01,
        filesRead: ['src/assets.ts'],
      }),
      persist,
      countHumanRoutes: async () => 0,
    });

    expect(persist).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1', commitSha: 'commit-123',
      claims: [expect.objectContaining({ route: '/assets/:id/edit', clientRefs: ['src/assets.ts'] }), {
        route: '/internal/debug', purpose: 'unknown', actions: [], clientRefs: [], serverRefs: [],
        audience: 'unknown', confidence: 0, evidenceConflicts: [],
      }],
    }));
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('caps confidence at 0.5 when conflicts exist and passes run metrics to persist', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'opslane-product-context-'));
    cleanupPaths.push(repoPath);
    await mkdir(join(repoPath, 'src'), { recursive: true });
    await writeFile(join(repoPath, 'src/a.ts'), 'export const save = () => undefined;');
    const persisted: unknown[] = [];
    const job = {
      id: 'job-conflicts', workerId: 'worker-1', leaseGeneration: '2', projectId: 'project-1',
      jobType: 'product_context', errorGroupId: null, eventId: null, sourceId: null,
      attempts: 2, guidance: null, triggeredBy: 'auto', sessionId: null,
    } satisfies ClaimedJob;

    await runProductContext(job, new AbortController().signal, {
      prepare: async () => ({
        repoPath, commitSha: 'commit-conflicts', cleanup: async () => undefined,
        routes: [
          { route: '/a', clientRefs: ['src/a.ts'], serverRefs: [], declaredRequests: ['PUT /api/a'] },
        ],
      }),
      askModel: async () => ({
        raw: { claims: [{
          route: '/a', purpose: 'Edit a thing', actions: ['save'],
          client_refs: ['src/a.ts'], server_refs: [], audience: 'standard', confidence: 0.9,
          evidence_conflicts: ['PUT /api/a has no handler'],
        }] },
        filesRead: ['src/a.ts'],
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        costUsd: 0.002,
      }),
      persist: async (write) => { persisted.push(write); return true; },
      countHumanRoutes: async () => 3,
    });

    const write = persisted[0] as {
      claims: { confidence: number }[];
      run: { execution: number; humanRouteCount: number; latencyMs: number };
      declaredRequests: Record<string, string[]>;
    };
    expect(write.claims[0]!.confidence).toBe(0.5);
    expect(write.run.execution).toBe(2);
    expect(write.run.humanRouteCount).toBe(3);
    expect(write.run.latencyMs).toBeGreaterThanOrEqual(0);
    expect(write.declaredRequests['/a']).toEqual(['PUT /api/a']);
  });

  it('mechanically discovers registered and file-system routes with their source files', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'opslane-product-context-'));
    cleanupPaths.push(repoPath);
    await mkdir(join(repoPath, 'src'), { recursive: true });
    await mkdir(join(repoPath, 'app/assets/[id]/edit'), { recursive: true });
    await writeFile(join(repoPath, 'src/router.ts'), `
      export const routes = [{ path: '/settings', component: Settings }];
    `);
    await writeFile(join(repoPath, 'app/assets/[id]/edit/page.tsx'), `
      export async function save() { await fetch('/api/assets/:id', { method: 'PUT' }); }
      export default function Page() {}
    `);

    await expect(discoverRepositoryRoutes(repoPath)).resolves.toEqual([
      { route: '/assets/:id/edit', clientRefs: ['app/assets/[id]/edit/page.tsx'], serverRefs: [], declaredRequests: ['PUT /api/assets/:id'] },
      { route: '/settings', clientRefs: ['src/router.ts'], serverRefs: [], declaredRequests: [] },
    ]);
  });

  it('fences mechanical discovery as data in the model prompt', () => {
    const prompt = buildProductContextPrompt([{
      route: '/assets/:id/edit', clientRefs: ['src/router.ts'],
      serverRefs: [], declaredRequests: ['PUT /api/assets/:id'],
    }]);
    expect(prompt).toContain('DISCOVERY_START');
    expect(prompt).toContain('DISCOVERY_END');
    expect(prompt).toContain('"route": "/assets/:id/edit"');
    expect(prompt).toContain('"PUT /api/assets/:id"');
  });
});

const baseClaim = {
  route: '/a',
  purpose: 'Edit a thing',
  actions: ['save'],
  client_refs: ['src/a.ts'],
  server_refs: [],
  audience: 'standard',
  confidence: 0.9,
  evidence_conflicts: [] as unknown[],
};

describe('evidence_conflicts', () => {
  it('is required on every claim', () => {
    const { evidence_conflicts: _dropped, ...withoutConflicts } = baseClaim;
    expect(() => parseRouteClaims({ claims: [withoutConflicts] }, ['/a']))
      .toThrow(/evidence_conflicts/);
  });

  it('accepts an empty list and deduplicates/trims entries', () => {
    const [claim] = parseRouteClaims({
      claims: [{ ...baseClaim, evidence_conflicts: [' PUT /x has no handler ', 'PUT /x has no handler'] }],
    }, ['/a']);
    expect(claim!.evidenceConflicts).toEqual(['PUT /x has no handler']);
  });

  it('rejects non-string entries', () => {
    expect(() => parseRouteClaims({
      claims: [{ ...baseClaim, evidence_conflicts: [42] }],
    }, ['/a'])).toThrow(/evidence_conflicts/);
  });
});

describe('declared requests naming', () => {
  it('discovery output and the model prompt say declaredRequests, not observedRequests', () => {
    const prompt = buildProductContextPrompt([
      { route: '/a', clientRefs: ['src/a.ts'], serverRefs: [], declaredRequests: ['PUT /api/a'] },
    ]);
    expect(prompt).toContain('declaredRequests');
    expect(prompt).not.toContain('observedRequests');
  });
});

describe.skipIf(!process.env['DATABASE_URL'])('product context persistence', () => {
  const pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });
  const suffix = crypto.randomUUID();
  let orgId: string;
  let projectId: string;
  let jobId: string;

  beforeAll(async () => {
    orgId = (await pool.query<{ id: string }>(
      `INSERT INTO orgs (name) VALUES ($1) RETURNING id`, [`product-context-${suffix}`],
    )).rows[0]!.id;
    projectId = (await pool.query<{ id: string }>(
      `INSERT INTO projects (org_id, name, github_repo) VALUES ($1, $2, $3) RETURNING id`,
      [orgId, `product-context-${suffix}`, `org/product-context-${suffix}`],
    )).rows[0]!.id;
    await pool.query(
      `INSERT INTO route_map (project_id, pattern, name, purpose, tier, source)
       VALUES ($1, '/assets/:id/edit', 'Assets', 'Human purpose', 'standard', 'human')`,
      [projectId],
    );
    jobId = (await pool.query<{ id: string }>(
      `INSERT INTO error_group_jobs
         (project_id, job_type, status, worker_id, lease_generation, lease_expires_at)
       VALUES ($1, 'product_context', 'claimed', 'worker-1', 1, now() + interval '5 minutes')
       RETURNING id`, [projectId],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM error_group_jobs WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM route_map WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
    await pool.query(`DELETE FROM orgs WHERE id = $1`, [orgId]);
    await pool.end();
    await closePool();
  });

  it('never overwrites a human-authored claim', async () => {
    await upsertProductContextClaims({
      projectId, jobId, workerId: 'worker-1', leaseGeneration: '1',
      commitSha: 'commit-123', promptVersion: 1, model: 'test-model',
      declaredRequests: {},
      run: {
        execution: 0, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        costUsd: 0, latencyMs: 1, humanRouteCount: 1,
      },
      claims: [{
        route: '/assets/:id/edit', purpose: 'Model purpose', actions: ['save'],
        clientRefs: ['src/assets.ts'], serverRefs: [], audience: 'standard', confidence: 0.9,
        evidenceConflicts: [],
      }],
    });
    const stored = await pool.query<{ purpose: string; source: string }>(
      `SELECT purpose, source FROM route_map WHERE project_id=$1 AND pattern=$2`,
      [projectId, '/assets/:id/edit'],
    );
    expect(stored.rows[0]).toEqual({ purpose: 'Human purpose', source: 'human' });
  });
});
