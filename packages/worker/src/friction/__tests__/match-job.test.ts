import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processFrictionMatch } from '../match-job.js';
import type { ClaimedJob } from '../../db.js';
import {
  EMBEDDING_DIMS,
  EMBEDDING_MODEL,
  EmbeddingsUnavailable,
  ticketText,
} from '../../embeddings.js';
import type { NarrativeClient, NarrativeModelResult } from '../../narrative/client.js';
import type { TicketRow } from '../tickets-db.js';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  txQuery: vi.fn(),
  release: vi.fn(),
  usage: vi.fn(),
  lease: vi.fn(),
  enqueue: vi.fn(),
  write: vi.fn(),
  shortlist: vi.fn(),
  nearest: vi.fn(),
  reserve: vi.fn(),
  commit: vi.fn(),
  create: vi.fn(),
  resolve: vi.fn(),
  match: vi.fn(),
  lockPublication: vi.fn(),
}));
vi.mock('../../db.js', () => ({
  getPool: () => ({
    query: mocks.query,
    connect: async () => ({ query: mocks.txQuery, release: mocks.release }),
  }),
  assertJobLease: mocks.lease,
  recordJobUsage: mocks.usage,
  enqueueJobTx: mocks.enqueue,
  LeaseLostError: class extends Error {},
}));
vi.mock('../persist.js', () => ({ writeObservationSignals: mocks.write }));
vi.mock('../tickets-db.js', () => ({
  lockPublication: mocks.lockPublication,
  shortlistTickets: mocks.shortlist,
  nearestTickets: mocks.nearest,
  reserveDecision: mocks.reserve,
  commitDecision: mocks.commit,
  createTicket: mocks.create,
  resolveMatchTicket: mocks.resolve,
  recordMatch: mocks.match,
}));
const job: ClaimedJob & { sessionId: string } = {
  id: 'job',
  projectId: 'project',
  sessionId: 'session',
  workerId: 'worker',
  leaseGeneration: '4',
  errorGroupId: null,
  eventId: null,
  sourceId: null,
  jobType: 'friction_match',
  attempts: 0,
  guidance: null,
  triggeredBy: null,
};
const definition = {
  name: 'Save error',
  control: 'Save',
  what_happened: 'A red error appears',
  steps: 'Click Save',
  kind: 'defect' as const,
};
const ticket: TicketRow = {
  id: 'ticket',
  project_id: 'project',
  environment_id: 'env',
  ...definition,
  screens_confirmed: [],
  screens_proposed: [],
  status: 'tracking',
  embedding: null,
  embedding_model: null,
  matched_count: 1,
  next_arrival_number: 1n,
  arrival_boundary: 0n,
  evidence_version: 0,
  live_generation: 0,
  fold_retries: 0,
  fixed_at: null,
  cohort_cutoff: null,
  reconcile_needed: false,
  reinvestigate_needed: false,
  merged_into: null,
  created_at: '',
  updated_at: '',
};
const observations = [
  { id: 'o1', what: 'Save shows a red error', evidenceLines: ['L1'] },
  { id: 'o2', what: 'Search returns duplicate rows', evidenceLines: ['L2'] },
];
function client(decisions: unknown) {
  return {
    modelName: 'claude-sonnet-5',
    complete: vi.fn(
      async (_args: Parameters<NarrativeClient['complete']>[0]): Promise<NarrativeModelResult> => ({
        text: JSON.stringify({ decisions }),
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 2,
        cacheWriteTokens: 3,
        stopReason: 'end_turn',
      }),
    ),
  };
}
const draft = {
  kind: 'draft',
  observation_id: 'o2',
  draft: { name: 'Search', control: 'Search', steps: 'Type' },
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.query.mockImplementation(async (sql: string) => ({
    rows: sql.includes('jsonb_build_object')
      ? [
          {
            session: {
              id: 'session',
              project_id: 'project',
              environment_id: 'env',
              end_user_id: null,
              started_at: '2026-09-11 01:00:00.123456+00',
            },
            project_name: 'project',
            narrative: { observations },
            timeline: {
              startTs: 1,
              lines: [
                { t: 'error', r: '/save', s: '#save', a: 1 },
                { t: 'duplicate', r: '/search', s: '#search', a: 2 },
              ],
            },
            verification_state: 'unsupported',
            verification: null,
            created_at: '2026-09-11 01:01:00.123456+00',
            prompt_version: 2,
          },
        ]
      : [],
  }));
  mocks.txQuery.mockResolvedValue({ rows: [], rowCount: 1 });
  mocks.write.mockResolvedValue([
    { signalId: 's1', observationId: 'o1' },
    { signalId: 's2', observationId: 'o2' },
  ]);
  mocks.shortlist.mockResolvedValue([ticket]);
  mocks.nearest.mockResolvedValue([ticket]);
  mocks.reserve.mockResolvedValue({ reserved: true });
  mocks.commit.mockResolvedValue(true);
  mocks.create.mockResolvedValue({ ...ticket, id: 'created' });
  mocks.resolve.mockImplementation(
    async (_tx: unknown, _scope: unknown, id: string) => ({ ...ticket, id }),
  );
});
describe('match job orchestration', () => {
  it('combines a cheap match and strong create, embedding the final immutable definition', async () => {
    const cheap = client([
      { kind: 'matched', observation_id: 'o1', ticket_id: 'ticket' },
      draft,
    ]);
    const strong = client([
      { kind: 'create', observation_id: 'o2', ticket: definition },
    ]);
    const embed = vi.fn(async (texts: string[]) => ({
      vectors: texts.map(() => Array(EMBEDDING_DIMS).fill(1)),
      model: EMBEDDING_MODEL,
    }));
    await processFrictionMatch(
      job,
      { cheap, strong, embed },
      new AbortController().signal,
    );
    expect(embed.mock.calls.map((call) => call[0])).toEqual([
      observations.map((o) => o.what),
      [ticketText({ ...draft.draft, what_happened: observations[1]!.what })],
      [ticketText(definition)],
    ]);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.anything(),
      { projectId: 'project', environmentId: 'env', ...definition },
      Array(EMBEDDING_DIMS).fill(1),
    );
    expect(mocks.commit.mock.calls.map((call) => call[2])).toEqual([
      { decision: 'matched', ticketId: 'ticket', decidedBy: 'cheap' },
      { decision: 'created', ticketId: 'created', decidedBy: 'strong' },
    ]);
    expect(mocks.match.mock.calls.map((call) => call[1].source)).toEqual([
      'cheap',
      'strong',
    ]);
    expect(mocks.create.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.reserve.mock.invocationCallOrder[1]!,
    );
    expect(mocks.usage).toHaveBeenCalledWith(
      expect.objectContaining({ execution: 4, phase: 'friction_first_look' }),
    );
    expect(cheap.complete.mock.calls[0]?.[0]).toMatchObject({
      signal: expect.any(AbortSignal),
    });
  });
  it('uses a committed reservation winner and never creates its proposed duplicate', async () => {
    const cheap = client(
      observations.map((o) => ({ ...draft, observation_id: o.id })),
    );
    const strong = client(
      observations.map((o) => ({
        kind: 'create',
        observation_id: o.id,
        ticket: definition,
      })),
    );
    mocks.reserve.mockResolvedValue({
      reserved: false,
      existing: {
        decision: 'created',
        ticket_id: 'winner',
        decided_by: 'strong',
      },
    });
    await processFrictionMatch(
      job,
      {
        cheap,
        strong,
        embed: async () => {
          throw new EmbeddingsUnavailable();
        },
      },
      new AbortController().signal,
    );
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.match).toHaveBeenCalledTimes(2);
    expect(
      mocks.match.mock.calls.every((call) => call[1].ticket.id === 'winner'),
    ).toBe(true);
  });
  it('leaves decision state untouched after two invalid strong responses and meters both', async () => {
    const cheap = client([
      { kind: 'matched', observation_id: 'o1', ticket_id: 'ticket' },
      draft,
    ]);
    const strong = client([]);
    await expect(
      processFrictionMatch(
        job,
        {
          cheap,
          strong,
          embed: async () => {
            throw new EmbeddingsUnavailable();
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/friction_first_look.*two attempts/);
    expect(strong.complete).toHaveBeenCalledTimes(2);
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.match).not.toHaveBeenCalled();
    expect(mocks.usage).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'friction_first_look',
        execution: 4,
        usage: { input: 20, output: 10, cacheRead: 4, cacheWrite: 6 },
      }),
    );
  });
});
