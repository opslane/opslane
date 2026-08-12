import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaimedJob } from '../db.js';

vi.mock('../db.js', () => ({
  listUnmappedPatterns: vi.fn(),
  getProject: vi.fn(),
  getProjectGitHubInstallation: vi.fn(),
  upsertRouteMapRows: vi.fn(),
}));
vi.mock('../github-app.js', () => ({ getInstallationToken: vi.fn() }));
vi.mock('../investigate.js', () => ({ INVESTIGATION_MODEL: 'claude-sonnet-5' }));
vi.mock('../readonly-agent.js', () => ({ runReadOnlyAgent: vi.fn() }));
vi.mock('../repo-clone.js', () => ({ cloneRepo: vi.fn() }));
vi.mock('../tracing.js', () => ({
  traceSpan: vi.fn((_name: string, _attributes: unknown, fn: () => unknown) => fn()),
}));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../db.js');
const { getInstallationToken } = await import('../github-app.js');
const { runReadOnlyAgent } = await import('../readonly-agent.js');
const { cloneRepo } = await import('../repo-clone.js');
const { processRouteMapJob } = await import('../route-map.js');

const job: ClaimedJob = {
  id: 'job-1',
  workerId: 'worker-1',
  errorGroupId: null,
  eventId: null,
  sourceId: null,
  projectId: 'project-1',
  jobType: 'route_map',
  attempts: 0,
  guidance: null,
  leaseGeneration: '3',
  triggeredBy: 'auto',
  sessionId: null,
};

describe('processRouteMapJob', () => {
  const cleanup = vi.fn(async () => undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    process.env['ANTHROPIC_API_KEY'] = 'anthropic-test';
    process.env['GITHUB_TOKEN'] = 'github-test';
    vi.mocked(db.getProject).mockResolvedValue({
      id: job.projectId,
      name: 'app',
      github_repo: 'org/repo',
      default_branch: 'main',
      friction_autonomy: 'ask_first',
    });
    vi.mocked(db.getProjectGitHubInstallation).mockResolvedValue({
      installationId: null,
      githubRepo: 'org/repo',
    });
    vi.mocked(cloneRepo).mockResolvedValue({ repoDir: '/tmp/repo', defaultBranch: 'main', headSha: 'abc123', cleanup });
    vi.mocked(db.upsertRouteMapRows).mockResolvedValue(true);
  });

  afterEach(() => {
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['GITHUB_TOKEN'];
  });

  it('completes as a no-op before resolving credentials when nothing is unmapped', async () => {
    vi.mocked(db.listUnmappedPatterns).mockResolvedValue([]);
    delete process.env['ANTHROPIC_API_KEY'];

    await expect(processRouteMapJob(job, new AbortController().signal)).resolves.toBeUndefined();

    expect(db.getProject).not.toHaveBeenCalled();
    expect(cloneRepo).not.toHaveBeenCalled();
  });

  it('classifies, persists neutral unresolved rows, and leaves completion to the poller', async () => {
    vi.mocked(db.listUnmappedPatterns).mockResolvedValue(['/assets/:id', '/unknown']);
    vi.mocked(runReadOnlyAgent).mockResolvedValue({
      terminalInput: { rows: [{
        pattern: '/assets/:id', name: 'Asset', purpose: 'View asset', tier: 'standard',
      }] },
      stop: 'terminal',
      filesRead: ['src/router.ts'],
      lastModelText: '',
      costUsd: 0.01,
      usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
    });

    await processRouteMapJob(job, new AbortController().signal);

    expect(cloneRepo).toHaveBeenCalledWith({
      githubRepo: 'org/repo', jobId: job.id, githubToken: 'github-test',
    });
    expect(runReadOnlyAgent).toHaveBeenCalledWith(expect.objectContaining({
      repoPath: '/tmp/repo',
      model: 'claude-sonnet-5',
      maxTurns: 20,
      budgetUsd: 0.5,
      terminalTool: expect.objectContaining({ name: 'submit_route_map' }),
    }));
    expect(db.upsertRouteMapRows).toHaveBeenCalledWith({
      projectId: job.projectId,
      jobId: job.id,
      workerId: job.workerId,
      leaseGeneration: job.leaseGeneration,
      rows: [{ pattern: '/assets/:id', name: 'Asset', purpose: 'View asset', tier: 'standard' }],
      unresolved: ['/unknown'],
    });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('uses a GitHub App installation token when one is connected', async () => {
    vi.mocked(db.listUnmappedPatterns).mockResolvedValue(['/']);
    vi.mocked(db.getProjectGitHubInstallation).mockResolvedValue({
      installationId: 42,
      githubRepo: 'org/repo',
    });
    vi.mocked(getInstallationToken).mockResolvedValue('installation-token');
    vi.mocked(runReadOnlyAgent).mockResolvedValue({
      terminalInput: { rows: [] }, stop: 'terminal', filesRead: [], lastModelText: '', costUsd: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });

    await processRouteMapJob(job, new AbortController().signal);

    expect(cloneRepo).toHaveBeenCalledWith(expect.objectContaining({ githubToken: 'installation-token' }));
  });

  it('throws a retryable error and cleans the clone on a non-terminal agent stop', async () => {
    vi.mocked(db.listUnmappedPatterns).mockResolvedValue(['/']);
    vi.mocked(runReadOnlyAgent).mockResolvedValue({
      terminalInput: null, stop: 'budget', filesRead: [], lastModelText: '', costUsd: 0.51,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    });

    await expect(processRouteMapJob(job, new AbortController().signal))
      .rejects.toThrow(/exceeded its budget/);
    expect(db.upsertRouteMapRows).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
