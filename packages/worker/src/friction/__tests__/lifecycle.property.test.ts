import { causeCoverage, fixEventCurrent } from '../fix-attempts.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  confirmationBatchCurrent,
  confirmationTransition,
  type TransitionPlan,
} from '../confirm-job.js';
import {
  evaluateBar,
  type CohortStats,
  type TicketStatus,
  type TicketRow,
  type ConfirmBatch,
} from '../tickets-db.js';

/** The memory store holds histories; production functions choose every batch
 * transition. SQL integration tests separately verify atomicity and evidence
 * membership. Fix/PR event and authored-card invariants belong to their handlers. */
class History {
  status: TicketStatus = 'tracking';
  generation = 0;
  fixedAt: number | null = null;
  clock = 0;
  version = 0;
  matches = new Map<
    number,
    {
      arrival: number;
      user: number | null;
      at: number;
      outcome?: 'confirmed' | 'refuted' | 'inconclusive';
    }
  >();
  nextArrival = 0;
  boundary = 0;
  live: {
    generation: number;
    resolved: boolean;
    evidence: Set<number>;
  } | null = null;
  retired: number[] = [];
  stats(): CohortStats {
    const cohort = [...this.matches.values()].filter(
      (m) => m.outcome && (this.fixedAt === null || m.at > this.fixedAt),
    );
    const confirmed = cohort.filter((m) => m.outcome === 'confirmed');
    const users = new Set(
      confirmed.flatMap((m) => (m.user === null ? [] : [m.user])),
    );
    return {
      counted: cohort.length,
      confirmed: confirmed.length,
      refuted: cohort.filter((m) => m.outcome === 'refuted').length,
      inconclusive: cohort.filter((m) => m.outcome === 'inconclusive').length,
      confirmedUsers: users.size,
      identityKnown: users.size > 0,
    };
  }
  evaluate() {
    const fix = this.live?.resolved ? 'resolved' : 'none';
    const action = confirmationTransition(
      this.status,
      fix,
      evaluateBar(this.stats(), { status: this.status, fixSubstate: fix }),
    );
    if (action === 'activate' || action === 'classify') {
      if (this.live) this.retired.push(this.live.generation);
      this.live = {
        generation: ++this.generation,
        resolved: false,
        evidence: new Set(),
      };
      this.status = 'published';
    } else if (action === 'unpublish') {
      if (this.live) this.retired.push(this.live.generation);
      this.live = null;
      this.status = 'unpublished';
    }
    if (this.live && !this.live.resolved)
      this.live.evidence = new Set(
        [...this.matches]
          .filter(
            ([, m]) =>
              m.outcome === 'confirmed' &&
              (this.fixedAt === null || m.at > this.fixedAt),
          )
          .map(([id]) => id),
      );
    return action;
  }
}
const event = fc.record({
  kind: fc.constantFrom(
    'arrive',
    'finalize',
    'delete',
    'identify',
    'resolve',
    'archive',
    'fold',
  ),
  id: fc.integer({ min: 0, max: 25 }),
  user: fc.option(fc.integer({ min: 0, max: 3 }), { nil: null }),
  outcome: fc.constantFrom(
    'confirmed' as const,
    'refuted' as const,
    'inconclusive' as const,
  ),
});
describe('randomized confirmation histories', () => {
  it('preserves terminal states, one live generation, verified membership, monotonic arrivals, immediate failure and post-fix cohorts', () => {
    fc.assert(
      fc.property(
        fc.array(event, { minLength: 1, maxLength: 200 }),
        (events) => {
          const store = new History();
          for (const e of events) {
            const previous = {
              status: store.status,
              generation: store.generation,
              arrival: store.nextArrival,
              boundary: store.boundary,
              resolved: store.live?.resolved,
            };
            store.clock++;
            if (store.status !== 'archived' && store.status !== 'merged') {
              if (e.kind === 'arrive' && !store.matches.has(e.id))
                store.matches.set(e.id, {
                  arrival: ++store.nextArrival,
                  at: store.clock,
                  user: e.user,
                });
              if (e.kind === 'finalize') {
                store.boundary = store.nextArrival;
                const match = store.matches.get(e.id);
                if (match && !match.outcome) {
                  match.outcome = e.outcome;
                  store.version++;
                }
                store.evaluate();
              }
              if (e.kind === 'delete') {
                store.matches.delete(e.id);
                store.version++;
                store.evaluate();
              }
              if (e.kind === 'identify') {
                const match = store.matches.get(e.id);
                if (match) match.user = e.user;
                store.evaluate();
              }
              if (e.kind === 'resolve' && store.live && !store.live.resolved) {
                store.live.resolved = true;
                store.fixedAt = store.clock;
              }
              if (
                e.kind === 'archive' ||
                (e.kind === 'fold' && store.status !== 'published')
              ) {
                if (store.live) store.retired.push(store.live.generation);
                store.live = null;
                store.status = e.kind === 'archive' ? 'archived' : 'merged';
              }
            }
            // 1: generations cannot coexist or be reused.
            expect(new Set(store.retired).size).toBe(store.retired.length);
            if (store.live)
              expect(store.retired).not.toContain(store.live.generation);
            // 2/4: every current member is this problem's own finalized confirmation.
            if (store.live && !store.live.resolved)
              for (const id of store.live.evidence)
                expect(store.matches.get(id)?.outcome).toBe('confirmed');
            // 5: neither terminal state can revive.
            if (previous.status === 'merged' || previous.status === 'archived')
              expect(store.status).toBe(previous.status);
            // 6: deletion and identity changes cannot lower or reuse arrival numbers.
            expect(store.nextArrival).toBeGreaterThanOrEqual(previous.arrival);
            expect(store.boundary).toBeGreaterThanOrEqual(previous.boundary);
            expect(
              new Set([...store.matches.values()].map((m) => m.arrival)).size,
            ).toBe(store.matches.size);
            // 7: a published source cannot fold.
            if (e.kind === 'fold' && previous.status === 'published')
              expect(store.status).toBe('published');
            // 9: every evaluation that fails removes the live publication immediately.
            if (store.status === 'published' && !store.live?.resolved)
              expect(
                evaluateBar(store.stats(), {
                  status: store.status,
                  fixSubstate: 'none',
                }),
              ).not.toBe('fails');
            // 11: a resolved generation survives a failing cohort; new generations
            // require three recordings strictly after its fix cutoff.
            if (previous.resolved && store.generation > previous.generation) {
              expect(store.stats().confirmed).toBeGreaterThanOrEqual(3);
              for (const id of store.live!.evidence)
                expect(store.matches.get(id)!.at).toBeGreaterThan(
                  store.fixedAt!,
                );
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });
  it('fences every state, generation, evidence and resolved-status mutation before a batch can finalize', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.constantFrom(
            'state',
            'generation',
            'evidence',
            'resolved',
            'fixing',
            'unchanged',
          ),
          { maxLength: 100 },
        ),
        (events) => {
          const selected = {
            status: 'published',
            live_generation: 4,
            evidence_version: 12,
            fixed_at: null,
          } as TicketRow;
          const batch = {
            status_at_select: 'published',
            live_generation_at_select: 4,
            evidence_version_at_select: 12,
          } as ConfirmBatch;
          const plan = {
            ticket: selected,
            incident: { fix_substate: 'none' },
          } as TransitionPlan;
          const current = { ...selected };
          let changed = false;
          let fixSubstate = 'none';
          for (const event of events) {
            if (event === 'state') {
              current.status = 'unpublished';
              changed = true;
            }
            if (event === 'generation') {
              current.live_generation++;
              changed = true;
            }
            if (event === 'evidence') {
              current.evidence_version++;
              changed = true;
            }
            if (event === 'resolved') {
              fixSubstate = 'resolved';
              current.fixed_at = '2026-09-12';
              changed = true;
            }
            if (event === 'fixing' && fixSubstate !== 'resolved')
              fixSubstate = 'fixing';
            const accepted = confirmationBatchCurrent(current, batch, plan, {
              id: 'incident',
              fix_substate: fixSubstate,
              evidence_version_used: 12,
              investigation_status: 'done',
              pr_url: null,
            });
            // 3 (batch generation fence) / 10: any invalidation must take the
            // discard-and-reconcile branch; a fix starting alone is unrelated.
            expect(accepted).toBe(!changed);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
  it('implements every bar boundary without allowing resolved or terminal failures to unpublish', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 100 }),
        fc.boolean(),
        fc.integer({ min: 0, max: 5 }),
        (a, b, identity, users) => {
          const stats = {
            counted: a + b,
            confirmed: a,
            refuted: b,
            inconclusive: 0,
            confirmedUsers: users,
            identityKnown: identity,
          };
          for (const status of [
            'tracking',
            'published',
            'unpublished',
            'merged',
            'archived',
          ] as const) {
            for (const fix of ['none', 'fixing', 'pr_open', 'resolved']) {
              const bar = evaluateBar(stats, { status, fixSubstate: fix });
              const transition = confirmationTransition(status, fix, bar);
              if (status === 'merged' || status === 'archived')
                expect(transition).toBe('none');
              if (fix === 'resolved') expect(transition).not.toBe('unpublish');
              if (transition === 'activate' || transition === 'classify') {
                expect(a).toBeGreaterThanOrEqual(3);
                expect(5 * a).toBeGreaterThanOrEqual(2 * (a + b));
                if (identity) expect(users).toBeGreaterThanOrEqual(2);
              }
            }
          }
        },
      ),
      { numRuns: 500 },
    );
    const stats = (counted: number, confirmed: number): CohortStats => ({
      counted,
      confirmed,
      refuted: counted - confirmed,
      inconclusive: 0,
      confirmedUsers: 2,
      identityKnown: true,
    });
    expect(
      evaluateBar(stats(16, 4), { status: 'published', fixSubstate: 'none' }),
    ).toBe('undecided');
    expect(
      evaluateBar(stats(15, 3), { status: 'published', fixSubstate: 'none' }),
    ).toBe('fails');
    expect(
      evaluateBar(stats(15, 3), {
        status: 'published',
        fixSubstate: 'resolved',
      }),
    ).toBe('undecided');
  });
});

describe('randomized cause and PR histories', () => {
  it('stale generations and retired attempts never apply a PR transition', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100000 }),
        fc.integer({ min: 1, max: 100 }),
        fc.constantFrom('opened', 'closed', 'merged'),
        (generation, offset, event) => {
          const live = {
            ticketStatus: 'published',
            liveGeneration: generation,
            generation,
            attemptGeneration: generation,
            groupStatus: 'fixing',
            fixSubstate: 'fixing',
            attemptStatus: 'active',
            event,
          };
          expect(fixEventCurrent(live)).toBe(true);
          expect(
            fixEventCurrent({ ...live, generation: generation - offset }),
          ).toBe(false);
          expect(
            fixEventCurrent({
              ...live,
              attemptGeneration: generation - offset,
            }),
          ).toBe(false);
          for (const attemptStatus of [
            'failed',
            'closed',
            'merged',
            'superseded',
          ])
            expect(fixEventCurrent({ ...live, attemptStatus })).toBe(false);
          expect(fixEventCurrent({ ...live, fixSubstate: 'resolved' })).toBe(
            false,
          );
        },
      ),
      { numRuns: 300 },
    );
  });
  it('new unexplained confirmed behavior removes cause eligibility at the half boundary', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100 }), (n) => {
        const explained = Array.from({ length: n }, (_, i) => `explained-${i}`);
        const other = Array.from({ length: n }, (_, i) => `new-${i}`);
        expect(
          causeCoverage([...explained, ...explained], [...explained, ...other]),
        ).toBe(0.5);
        expect(
          causeCoverage(explained, [
            ...explained,
            ...other,
            'one-more-confirmed',
          ]),
        ).toBeLessThan(0.5);
        expect(causeCoverage(explained, other)).toBe(0);
      }),
      { numRuns: 300 },
    );
  });
});
