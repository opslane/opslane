import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub pg.PoolClient used by the function under test.
interface FakeClient {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

// Stub transitive imports that pull in workspace packages not resolved in tests.
vi.mock('../../metered.js', () => ({ PhaseMeter: vi.fn() }));
vi.mock('../../run-logs/context.js', () => ({ runContextFromJob: vi.fn() }));
vi.mock('../confirm-job.js', () => ({
  applyConfirmationTransition: vi.fn(),
  prepareConfirmationTransition: vi.fn(),
  confirmationSnapshotCurrent: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks – the real modules talk to Postgres; we replace them entirely.
// ---------------------------------------------------------------------------
vi.mock('../../db.js', () => ({
  getPool: vi.fn(),
}));

vi.mock('../tickets-db.js', () => ({
  publicationPaused: vi.fn(),
  lockTicketPublication: vi.fn(),
  getTicket: vi.fn(),
  liveIncident: vi.fn(),
  verifiedEvidence: vi.fn(),
  investigationAllowed: vi.fn(),
  enqueueTicketInvestigation: vi.fn(),
}));

vi.mock('../fix-attempts.js', () => ({
  CAUSE_COVERAGE_MIN: 0.5,
  causeCoverage: vi.fn(),
}));

import * as db from '../../db.js';
import * as store from '../tickets-db.js';
import { causeCoverage } from '../fix-attempts.js';
import { reconcileDilutedCoverage } from '../reconcile-job.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fakeClient(): FakeClient {
  return {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: vi.fn(),
  };
}

function fakePool(candidates: Array<{ ticket_id: string; project_id: string }>) {
  const client = fakeClient();
  const pool = {
    query: vi.fn().mockResolvedValue({ rows: candidates, rowCount: candidates.length }),
    connect: vi.fn().mockResolvedValue(client),
  };
  vi.mocked(db.getPool).mockReturnValue(pool as any);
  return { pool, client };
}

const published = {
  id: 't1',
  project_id: 'p1',
  environment_id: 'e1',
  status: 'published',
  live_generation: 1,
  kind: 'defect' as const,
} as any;

const incident = {
  id: 'g1',
  fix_substate: 'none',
  investigation_status: 'done',
  explained_signal_ids: ['s1'],
  pr_url: null,
  evidence_version_used: 1,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(store.publicationPaused).mockReturnValue(false);
});

describe('reconcileDilutedCoverage', () => {
  it('queues exactly one investigation when explained recordings aged out', async () => {
    const { client } = fakePool([{ ticket_id: 't1', project_id: 'p1' }]);
    vi.mocked(store.getTicket).mockResolvedValue(published);
    vi.mocked(store.liveIncident).mockResolvedValue(incident);
    vi.mocked(store.verifiedEvidence).mockResolvedValue({
      users: 3,
      sessions: 3,
      accounts: [],
      sessionIds: ['ses1', 'ses2', 'ses3'],
      signalIds: ['s2', 's3', 's4'], // new signals, old s1 aged out
      representative: null,
    });
    vi.mocked(causeCoverage).mockReturnValue(0); // 0 of 3 explained
    vi.mocked(store.investigationAllowed).mockReturnValue(true);
    vi.mocked(store.enqueueTicketInvestigation).mockResolvedValue(true);

    const queued = await reconcileDilutedCoverage();

    expect(queued).toBe(1);
    expect(store.enqueueTicketInvestigation).toHaveBeenCalledTimes(1);
    expect(store.enqueueTicketInvestigation).toHaveBeenCalledWith(
      client,
      published,
      'g1',
    );
    expect(client.query).toHaveBeenCalledWith('COMMIT');
  });

  it('skips when the seven-day window is empty', async () => {
    fakePool([{ ticket_id: 't1', project_id: 'p1' }]);
    vi.mocked(store.getTicket).mockResolvedValue(published);
    vi.mocked(store.liveIncident).mockResolvedValue(incident);
    vi.mocked(store.verifiedEvidence).mockResolvedValue({
      users: 0,
      sessions: 0,
      accounts: [],
      sessionIds: [],
      signalIds: [],
      representative: null,
    });

    const queued = await reconcileDilutedCoverage();

    expect(queued).toBe(0);
    expect(store.enqueueTicketInvestigation).not.toHaveBeenCalled();
  });

  it('skips when a fix is in flight', async () => {
    fakePool([{ ticket_id: 't1', project_id: 'p1' }]);
    vi.mocked(store.getTicket).mockResolvedValue(published);
    vi.mocked(store.liveIncident).mockResolvedValue({
      ...incident,
      fix_substate: 'fixing',
    });

    const queued = await reconcileDilutedCoverage();

    expect(queued).toBe(0);
    expect(store.enqueueTicketInvestigation).not.toHaveBeenCalled();
  });

  it('skips when a PR is open', async () => {
    fakePool([{ ticket_id: 't1', project_id: 'p1' }]);
    vi.mocked(store.getTicket).mockResolvedValue(published);
    vi.mocked(store.liveIncident).mockResolvedValue({
      ...incident,
      fix_substate: 'pr_open',
    });

    const queued = await reconcileDilutedCoverage();

    expect(queued).toBe(0);
    expect(store.enqueueTicketInvestigation).not.toHaveBeenCalled();
  });

  it('skips when the fix has already merged', async () => {
    fakePool([{ ticket_id: 't1', project_id: 'p1' }]);
    vi.mocked(store.getTicket).mockResolvedValue(published);
    vi.mocked(store.liveIncident).mockResolvedValue({
      ...incident,
      fix_substate: 'resolved',
    });

    const queued = await reconcileDilutedCoverage();

    expect(queued).toBe(0);
    expect(store.enqueueTicketInvestigation).not.toHaveBeenCalled();
  });

  it('skips when coverage is still adequate', async () => {
    fakePool([{ ticket_id: 't1', project_id: 'p1' }]);
    vi.mocked(store.getTicket).mockResolvedValue(published);
    vi.mocked(store.liveIncident).mockResolvedValue(incident);
    vi.mocked(store.verifiedEvidence).mockResolvedValue({
      users: 3,
      sessions: 3,
      accounts: [],
      sessionIds: ['ses1'],
      signalIds: ['s1', 's2'],
      representative: null,
    });
    vi.mocked(causeCoverage).mockReturnValue(0.6); // above 0.5

    const queued = await reconcileDilutedCoverage();

    expect(queued).toBe(0);
    expect(store.enqueueTicketInvestigation).not.toHaveBeenCalled();
  });

  it('does not queue duplicates on repeated passes', async () => {
    fakePool([{ ticket_id: 't1', project_id: 'p1' }]);
    vi.mocked(store.getTicket).mockResolvedValue(published);
    vi.mocked(store.liveIncident).mockResolvedValue(incident);
    vi.mocked(store.verifiedEvidence).mockResolvedValue({
      users: 2,
      sessions: 2,
      accounts: [],
      sessionIds: ['ses1', 'ses2'],
      signalIds: ['s5', 's6'],
      representative: null,
    });
    vi.mocked(causeCoverage).mockReturnValue(0);
    vi.mocked(store.investigationAllowed).mockReturnValue(true);
    // enqueueTicketInvestigation returns false when a pending job already exists
    vi.mocked(store.enqueueTicketInvestigation).mockResolvedValue(false);

    const queued = await reconcileDilutedCoverage();

    expect(queued).toBe(0);
    expect(store.enqueueTicketInvestigation).toHaveBeenCalledTimes(1);
  });

  it('returns zero when publication is paused', async () => {
    vi.mocked(store.publicationPaused).mockReturnValue(true);

    const queued = await reconcileDilutedCoverage();

    expect(queued).toBe(0);
    expect(db.getPool).not.toHaveBeenCalled();
  });

  it('rolls back and continues on unexpected error for one ticket', async () => {
    fakePool([
      { ticket_id: 't1', project_id: 'p1' },
      { ticket_id: 't2', project_id: 'p1' },
    ]);
    const second = { ...published, id: 't2' };
    vi.mocked(store.getTicket)
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce(second);
    vi.mocked(store.liveIncident).mockResolvedValue(incident);
    vi.mocked(store.verifiedEvidence).mockResolvedValue({
      users: 1,
      sessions: 1,
      accounts: [],
      sessionIds: ['ses1'],
      signalIds: ['s9'],
      representative: null,
    });
    vi.mocked(causeCoverage).mockReturnValue(0);
    vi.mocked(store.investigationAllowed).mockReturnValue(true);
    vi.mocked(store.enqueueTicketInvestigation).mockResolvedValue(true);

    const queued = await reconcileDilutedCoverage();

    // First ticket errored, second succeeded.
    expect(queued).toBe(1);
  });
});
