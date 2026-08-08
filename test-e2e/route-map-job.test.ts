/**
 * E2E: Route-map job — claim → dispatch → clone → classify → fenced upsert.
 *
 * Runs the real worker binary against a protocol-compatible Anthropic stub
 * (ANTHROPIC_BASE_URL), so the queue path is driven end to end with no model
 * cost and no flakiness. The stub classifies exactly ONE asked pattern, which
 * forces the llm-unresolved path for the rest — the convergence guarantee that
 * keeps the sweeper from re-enqueueing forever. Codified from verify run
 * 20260808-005041 (AC8/AC9); sweeper-side enqueue dedupe is covered by the Go
 * suite in packages/ingestion/priority.
 *
 * Required:
 *   DATABASE_URL   — Postgres connection string
 *   GITHUB_TOKEN   — token able to clone E2E_ROUTE_MAP_REPO
 *   E2E_ROUTE_MAP_REPO — clonable owner/repo (default opslane/defender-test-fixture)
 *   packages/worker must be built (dist/index.js).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  seedTenant,
  seedErrorGroup,
  getPool,
  cleanupTenant,
  closePool,
  getConfig,
  type TestTenant,
} from './helpers.js';

const workerEntry = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../packages/worker/dist/index.js',
);
const repo = process.env['E2E_ROUTE_MAP_REPO'] ?? 'opslane/defender-test-fixture';
const runnable = !!process.env['GITHUB_TOKEN'] && existsSync(workerEntry);

/**
 * Minimal Anthropic /v1/messages stub: always answers with a submit_route_map
 * tool_use for the FIRST pattern in the message's PATTERNS_START JSON block.
 */
function startAnthropicStub(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let first = '/stub-unknown';
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as {
          messages?: Array<{ content?: unknown }>;
        };
        const text = (body.messages ?? [])
          .flatMap((m) =>
            typeof m.content === 'string'
              ? [m.content]
              : Array.isArray(m.content)
                ? m.content
                    .filter((b): b is { type: string; text: string } =>
                      typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text')
                    .map((b) => b.text)
                : [],
          )
          .join('\n');
        const match = /PATTERNS_START\s*(\[[\s\S]*?\])\s*PATTERNS_END/.exec(text);
        if (match) first = (JSON.parse(match[1]!) as string[])[0] ?? first;
      } catch {
        // fall through with the sentinel pattern; the parser guard will reject it
      }
      const payload = JSON.stringify({
        id: 'msg_stub',
        type: 'message',
        role: 'assistant',
        model: 'stub',
        content: [{
          type: 'tool_use',
          id: 'tu_stub',
          name: 'submit_route_map',
          input: { rows: [{ pattern: first, name: 'Stub page', purpose: 'stub classification', tier: 'standard' }] },
        }],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 },
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(payload);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe.skipIf(!runnable)('route_map job pipeline (stubbed model)', () => {
  let tenant: TestTenant;
  let stub: Awaited<ReturnType<typeof startAnthropicStub>>;
  let worker: ChildProcess | undefined;

  beforeAll(async () => {
    tenant = await seedTenant(repo);
    const db = getPool();

    // Two open groups with stamped patterns and one human-owned route row.
    // seedErrorGroup also enqueues investigate jobs; the worker processes those
    // too (pre-clone short-circuit), which mirrors a real mixed queue.
    const groupA = await seedErrorGroup({
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      status: 'new',
      title: 'route-map e2e group A',
    });
    const groupB = await seedErrorGroup({
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      status: 'new',
      title: 'route-map e2e group B',
    });
    await db.query(
      `UPDATE error_groups SET page_url_normalized = '/e2e-route-a' WHERE id = $1`, [groupA]);
    await db.query(
      `UPDATE error_groups SET page_url_normalized = '/e2e-route-b' WHERE id = $1`, [groupB]);
    await db.query(
      `INSERT INTO route_map (project_id, pattern, name, purpose, tier, source)
       VALUES ($1, '/e2e-human', 'Hand-tuned page', 'must survive', 'customer', 'human')`,
      [tenant.projectId]);
    // Enqueue directly (the sweeper's enqueue statement is Go-tested); this
    // test owns claim → dispatch → upsert.
    await db.query(
      `INSERT INTO error_group_jobs (project_id, job_type) VALUES ($1, 'route_map')`,
      [tenant.projectId]);

    stub = await startAnthropicStub();
    const workerLog: string[] = [];
    worker = spawn(process.execPath, [workerEntry], {
      cwd: path.resolve(path.dirname(workerEntry), '..'),
      env: {
        // Strip VITEST: the worker entrypoint deliberately skips startup under
        // vitest (dist/index.js is imported by unit tests), but THIS child must
        // actually boot.
        ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'VITEST')),
        DATABASE_URL: getConfig().databaseUrl,
        ANTHROPIC_BASE_URL: stub.url,
        ANTHROPIC_API_KEY: 'stub-key',
        WORKER_POLL_INTERVAL_MS: '1000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    worker.stdout?.on('data', (c: Buffer) => workerLog.push(c.toString()));
    worker.stderr?.on('data', (c: Buffer) => workerLog.push(c.toString()));
    let workerExit: number | null = null;
    worker.on('exit', (code) => { workerExit = code; });

    // Poll the job to completion.
    const start = Date.now();
    for (;;) {
      if (workerExit !== null) {
        throw new Error(`worker exited early (${workerExit}): ${workerLog.join('').slice(-2000)}`);
      }
      const { rows } = await db.query<{ status: string }>(
        `SELECT status FROM error_group_jobs WHERE project_id = $1 AND job_type = 'route_map'`,
        [tenant.projectId]);
      const status = rows[0]?.status;
      if (status === 'completed') break;
      if (status === 'dead_letter') {
        throw new Error(`route_map job dead-lettered: ${workerLog.join('').slice(-2000)}`);
      }
      if (Date.now() - start > 120_000) {
        throw new Error(`route_map job stuck in ${status}. Worker log tail: ${workerLog.join('').slice(-2000)}`);
      }
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }, 150_000);

  afterAll(async () => {
    worker?.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 1_000));
    await stub?.close();
    await cleanupTenant(tenant.orgId);
    await closePool();
  });

  it('classifies one pattern via the model and parks the rest as llm-unresolved', async () => {
    const { rows } = await getPool().query<{ pattern: string; name: string; tier: string; source: string }>(
      `SELECT pattern, name, tier, source FROM route_map
       WHERE project_id = $1 AND pattern IN ('/e2e-route-a', '/e2e-route-b') ORDER BY pattern`,
      [tenant.projectId]);
    expect(rows).toHaveLength(2);
    const llm = rows.filter((r) => r.source === 'llm');
    const unresolved = rows.filter((r) => r.source === 'llm-unresolved');
    expect(llm).toHaveLength(1);
    expect(unresolved).toHaveLength(1);
    expect(llm[0]!.name).toBe('Stub page');
    expect(llm[0]!.tier).toBe('standard');
    // llm-unresolved rows are weight-neutral placeholders named by pattern.
    expect(unresolved[0]!.tier).toBe('standard');
    expect(unresolved[0]!.name).toBe(unresolved[0]!.pattern);
  });

  it('never overwrites a human route row', async () => {
    const { rows } = await getPool().query(
      `SELECT name, purpose, tier, source FROM route_map WHERE project_id = $1 AND pattern = '/e2e-human'`,
      [tenant.projectId]);
    expect(rows[0]).toEqual({
      name: 'Hand-tuned page',
      purpose: 'must survive',
      tier: 'customer',
      source: 'human',
    });
  });
});
