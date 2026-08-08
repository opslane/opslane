/**
 * E2E: Priority score pipeline — event → sweeper → priority-ordered read API.
 *
 * Drives the seam no unit test can see: real ingestion, the priority sweeper's
 * tick, and the incidents feed, the way a user's SDK and dashboard drive them.
 * Codified from verify run 20260808-005041 (AC1–AC6).
 *
 * Required:
 *   DATABASE_URL                     — Postgres connection string
 *   INGESTION_URL                    — ingestion API (default http://localhost:8082)
 *   PRIORITY_SCORE_INTERVAL_SECONDS  — must be ≤30 on the stack under test so a
 *                                      tick lands inside the poll deadline. The
 *                                      suite skips (not fails) when unset/large,
 *                                      because against a default 30-minute tick
 *                                      the deadline would always lapse.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  seedTenant,
  postEvent,
  listIncidents,
  cleanupTenant,
  closePool,
  type Incident,
  type TestTenant,
} from './helpers.js';

const tickSeconds = Number(process.env['PRIORITY_SCORE_INTERVAL_SECONDS'] ?? NaN);
const fastTick = Number.isFinite(tickSeconds) && tickSeconds > 0 && tickSeconds <= 30;

const OPAQUE_TOKEN = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

function eventPayload(opts: {
  type: string;
  url: string;
  sessionId: string;
  userId?: string;
}): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    error: {
      type: opts.type,
      message: `${opts.type} message`,
      // The stack carries an app frame on purpose: a concurrently running
      // worker (this suite runs files in parallel; route-map-job.test.ts
      // spawns one) triages no-app-frames stacks straight to
      // unfixable_no_app_frames, which is in the priority cap set and would
      // multiply these scores by 0.1 mid-assertion. With an app frame the
      // worker's outcome stays outside the capped reason codes.
      stack: `${opts.type}: message\n  at handlePriorityFixture (src/priority-fixture.ts:10:5)\n  at ${opts.url}:1:1`,
    },
    context: {
      url: opts.url,
      ...(opts.userId ? { user: { id: opts.userId } } : {}),
    },
    session_id: opts.sessionId,
  };
}

/** Poll the incidents feed until every listed title carries a score, or deadline. */
async function pollScored(
  tenant: TestTenant,
  titles: string[],
  deadlineMs = 90_000,
): Promise<Incident[]> {
  const start = Date.now();
  for (;;) {
    const incidents = await listIncidents(tenant.userSession, tenant.projectId);
    const wanted = incidents.filter((i) => titles.some((t) => i.title.includes(t)));
    if (
      wanted.length === titles.length &&
      wanted.every((i) => i.priority_score !== undefined && i.priority_score !== null)
    ) {
      return incidents;
    }
    if (Date.now() - start > deadlineMs) {
      throw new Error(
        `Timed out waiting for scores. Feed: ${incidents
          .map((i) => `${i.title.slice(0, 30)}=${i.priority_score ?? 'null'}`)
          .join(', ')}`,
      );
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

describe.skipIf(!fastTick)('priority score pipeline (event → sweeper → feed)', () => {
  let tenant: TestTenant;
  let incidents: Incident[];

  const byTitle = (fragment: string): Incident => {
    const found = incidents.find((i) => i.title.includes(fragment));
    if (!found) throw new Error(`incident ${fragment} missing from feed`);
    return found;
  };

  beforeAll(async () => {
    tenant = await seedTenant();

    // HI: two identified users on the same group, then LO: one anonymous
    // session on a different group with a NEWER last_seen. Priority must beat
    // recency in the feed order.
    const posts: Array<Parameters<typeof eventPayload>[0]> = [
      { type: 'E2EPriorityHi', url: 'https://app.example.com/loanees', sessionId: 'e2e-pri-s1', userId: 'e2e-pri-u1' },
      { type: 'E2EPriorityHi', url: 'https://app.example.com/loanees', sessionId: 'e2e-pri-s2', userId: 'e2e-pri-u2' },
      // additive: one identified user AND one anonymous-only session
      { type: 'E2EPriorityMixed', url: 'https://app.example.com/alerts', sessionId: 'e2e-pri-s3', userId: 'e2e-pri-u3' },
      { type: 'E2EPriorityMixed', url: 'https://app.example.com/alerts', sessionId: 'e2e-pri-s4' },
      // identified with a templatable id in the path
      { type: 'E2EPriorityAssets', url: 'https://app.example.com/assets/2985977', sessionId: 'e2e-pri-s5', userId: 'e2e-pri-u4' },
      // opaque token path, anonymous
      { type: 'E2EPriorityToken', url: `https://app.example.com/sign/${OPAQUE_TOKEN}`, sessionId: 'e2e-pri-s6' },
      // LO last so its last_seen is newest
      { type: 'E2EPriorityLo', url: 'https://app.example.com/loanees', sessionId: 'e2e-pri-s7' },
    ];
    for (const p of posts) {
      const res = await postEvent(tenant.ingestKey, eventPayload(p));
      expect(res.status).toBe(202);
    }

    incidents = await pollScored(tenant, [
      'E2EPriorityHi',
      'E2EPriorityMixed',
      'E2EPriorityAssets',
      'E2EPriorityToken',
      'E2EPriorityLo',
    ]);
  }, 120_000);

  afterAll(async () => {
    await cleanupTenant(tenant.orgId);
    await closePool();
  });

  it('scores identified reach with the recency boost', () => {
    // 2 users in 7d, both in 24h: impact = 2 + 2*2 = 6, weight 1, no cap.
    const hi = byTitle('E2EPriorityHi');
    expect(hi.priority_score).toBeCloseTo(6, 5);
    expect(hi.priority_scored_at).toBeTruthy();
  });

  it('scores anonymous-only sessions instead of dropping them to zero', () => {
    const lo = byTitle('E2EPriorityLo');
    expect(lo.priority_score).toBeCloseTo(3, 5);
    expect(lo.priority_inputs?.users_7d).toBe(0);
    expect(lo.priority_inputs?.anon_sessions_7d).toBe(1);
  });

  it('adds identified and anonymous reach instead of letting one swallow the other', () => {
    const mixed = byTitle('E2EPriorityMixed');
    expect(mixed.priority_inputs?.users_7d).toBe(1);
    expect(mixed.priority_inputs?.anon_sessions_7d).toBe(1);
    expect(mixed.priority_score).toBeCloseTo(6, 5);
  });

  it('exposes the canonical 11-key inputs shape with a boolean cap', () => {
    const inputs = byTitle('E2EPriorityAssets').priority_inputs;
    expect(inputs).toBeDefined();
    expect(Object.keys(inputs!).sort()).toEqual([
      'anon_sessions_24h',
      'anon_sessions_7d',
      'cap_applied',
      'impact',
      'reason_code',
      'route_name',
      'route_pattern',
      'route_tier',
      'route_weight',
      'users_24h',
      'users_7d',
    ]);
    expect(inputs!.cap_applied).toBe(false);
    expect(inputs!.route_pattern).toBe('/assets/:id');
  });

  it('orders the feed by priority, not last-seen', () => {
    // LO was posted last (newest last_seen) but HI must come first.
    const hiIndex = incidents.findIndex((i) => i.title.includes('E2EPriorityHi'));
    const loIndex = incidents.findIndex((i) => i.title.includes('E2EPriorityLo'));
    expect(hiIndex).toBeGreaterThanOrEqual(0);
    expect(hiIndex).toBeLessThan(loIndex);
  });

  it('templates opaque path segments before they reach the stamp or the API', () => {
    const token = byTitle('E2EPriorityToken');
    expect(token.priority_inputs?.route_pattern).toBe('/sign/:token');
    // The raw token must not appear anywhere in the feed payload. The stack
    // trace posted for this group deliberately contains the URL, so this also
    // proves the read surface carries the stamp, not the raw path.
    expect(JSON.stringify(token.priority_inputs)).not.toContain(OPAQUE_TOKEN);
  });
});
