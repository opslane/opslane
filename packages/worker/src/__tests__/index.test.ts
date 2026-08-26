import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import type { ClaimedJob, ErrorGroupData, ErrorEventData, ProjectData } from '../db.js';
import type { EvidenceBundle } from '../evidence/bundle.js';
import { VerificationInfraError } from '../harness/errors.js';

// index.ts is the worker entrypoint: it imports the whole world and calls main()
// at module load. We mock every dependency so importing it is side-effect free,
// and main() is guarded behind !process.env.VITEST so the poller/servers never
// boot here. The ONE module we deliberately leave real is harness/stack-trace-utils
// (hasNoAppFrames) — that's the decision under test.
vi.mock('../db.js', async () => ({
  LeaseLostError: class LeaseLostError extends Error {},
  getErrorGroup: vi.fn(),
  getErrorEvent: vi.fn(),
  getProject: vi.fn(),
  getProjectGitHubInstallation: vi.fn(),
  cacheProjectDefaultBranch: vi.fn(),
  updateGroupStatus: vi.fn(),
  updateGroupInvestigation: vi.fn(),
  updateGroupAndCreateFixJob: vi.fn(),
  getGroupInvestigation: vi.fn(),
  getReplayForGroup: vi.fn(),
  getSessionPointerForGroup: vi.fn(),
  getEnvironmentNamesForGroup: vi.fn(async () => ({ names: [], totalCount: 0 })),
  getPlayableChunkMetas: vi.fn(),
  getReplayArtifacts: vi.fn(),
  getSourceMapRows: vi.fn(async () => []),
  getResolvedEnvelope: vi.fn(async () => null),
  requeueStaleJobs: vi.fn(),
  resolveInactiveGroups: vi.fn(),
  resolveSilentMergedGroups: vi.fn(),
  updateJobTraceUrl: vi.fn(),
  closePool: vi.fn(),
  getFrictionSignalsForGroup: vi.fn(),
  getScrubbedChunksForSession: vi.fn(),
  getSessionForAnalysis: vi.fn(),
  upsertSessionAnalysis: vi.fn(),
  getSessionAnalysis: vi.fn(),
  getScrubbedChunksInRange: vi.fn(),
  enqueueSessionAnalysisForBudgetRetry: vi.fn(),
  setSessionAnalysisStatus: vi.fn(),
  assertJobLease: vi.fn(),
  reserveDelivery: vi.fn(),
  recordDeliveryPushed: vi.fn(),
  finalizeDelivery: vi.fn(),
  recordJobUsage: vi.fn(),
  recordFixTerminalDecision: vi.fn(),
  recordInvestigatedCommit: vi.fn(),
  getGroupImpactBar: vi.fn(async () => ({ identifiedUsers: 1, recentAnonSessions: 0, eligible: true })),
  getFrictionGroupImpactBar: vi.fn(async () => ({ identifiedUsers: 5, recentAnonSessions: 0, eligible: true })),
  // Pure shape helper: mirror the real implementation so decision assertions
  // see the exact persisted policy fields.
  policyFields: (bar: { identifiedUsers: number; recentAnonSessions: number; eligible: boolean } | null) =>
    bar
      ? {
          policyEligible: bar.eligible,
          policyBasis: { v: 1, identified_users: bar.identifiedUsers, recent_anon_sessions: bar.recentAnonSessions },
        }
      : { policyEligible: null, policyBasis: null },
  // Real implementation, not a copy: a drift in the anchor-preference rule
  // must fail these tests, not be masked by a stale reimplementation.
  resolveEvidenceEventId: (await vi.importActual<typeof import('../db.js')>('../db.js')).resolveEvidenceEventId,
}));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  setWorkerId: vi.fn(),
  safeErrorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));
vi.mock('../repo-clone.js', async (importOriginal) => {
  // The retriable-clone classifier runs REAL: the tests assert the actual
  // routing decision, not a stub's.
  const real = await importOriginal<typeof import('../repo-clone.js')>();
  return {
    cloneRepo: vi.fn(),
    buildRepoUrl: vi.fn((githubRepo: string) => `https://github.com/${githubRepo}.git`),
    isRetriableCloneFailure: real.isRetriableCloneFailure,
    sweepAbandonedClones: vi.fn(async () => 0),
    cloneFailureReason: vi.fn((error: unknown) => ({
      reason_code: 'repo_access_denied',
      reason_message: error instanceof Error ? error.message : String(error),
      remediation: 'Check repository access',
    })),
  };
});
vi.mock('../minio-client.js', () => ({ fetchObject: vi.fn(), getMinIOConfig: vi.fn(() => null) }));
vi.mock('../investigate.js', () => ({
  investigateError: vi.fn(),
  // index.ts records this on the immutable decision row, so the mock must carry
  // it rather than let the module re-derive its own default.
  INVESTIGATION_MODEL: 'claude-sonnet-5',
}));
vi.mock('../pipeline.js', () => ({ runPipeline: vi.fn() }));
vi.mock('../poller.js', () => ({ createPoller: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })) }));
vi.mock('../github-app.js', () => ({ getInstallationToken: vi.fn() }));
vi.mock('../route-map.js', () => ({ processRouteMapJob: vi.fn() }));
vi.mock('../product-context/job.js', () => ({ runProductContext: vi.fn() }));
vi.mock('../inquiry/job.js', () => ({ runInquiry: vi.fn() }));
vi.mock('../digest-writer/job.js', () => ({ writeDigest: vi.fn() }));
vi.mock('../evidence/bundle.js', () => ({ loadEvidence: vi.fn() }));
vi.mock('../score-sync.js', () => ({ processScoreSyncJob: vi.fn() }));
vi.mock('../resolve/job.js', () => ({ runStackResolve: vi.fn() }));
vi.mock('../scores.js', () => ({ pushScore: vi.fn() }));
vi.mock('../pr.js', () => ({}));
vi.mock('../source-map.js', () => ({ parseStackFrames: vi.fn(() => []), resolveFrame: vi.fn() }));
// Only the storage-backed resolver is stubbed. framesFromEnvelope is a pure
// reshape of an already-stored row, so the real one keeps this suite honest
// about the shape the prompts actually receive.
vi.mock('../resolve-stack.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../resolve-stack.js')>()),
  resolveEventStack: vi.fn(async () => ({
    status: 'no_debug_ids', frames: null, envelope: null,
  })),
}));
vi.mock('../tracing.js', () => ({
  initTracing: vi.fn(),
  shutdownTracing: vi.fn(),
  withJobTrace: vi.fn(),
  getActiveTraceId: vi.fn(() => null),
  buildLangfuseTraceUrl: vi.fn(() => null),
}));
vi.mock('../visual-analysis.js', () => ({ runVisualAnalysis: vi.fn() }));
vi.mock('../friction/friction-evidence.js', () => ({ gatherFrictionEvidence: vi.fn() }));
vi.mock('../friction/investigate-friction.js', () => ({
  investigateFriction: vi.fn(),
  FRICTION_INVESTIGATION_MODEL: 'claude-sonnet-4-6',
}));
vi.mock('../friction/chunk-reader.js', () => ({ readChunksBounded: vi.fn() }));
vi.mock('../friction/analyzer.js', () => ({ analyzeSession: vi.fn(), RULE_VERSION: 2 }));
vi.mock('../friction/facts.js', () => ({
  extractSessionFacts: vi.fn(() => ({
    entryPath: null, clickCount: 0, inputEventCount: 0, pageEventCount: 0,
    failedRequest4xxCount: 0, failedRequest5xxCount: 0,
    unattributedFailedRequestCount: 0, successfulWriteCount: 0, failedWriteCount: 0,
    firstEventMs: null, lastEventMs: null, failures: [], successes: [],
  })),
  deriveCoverage: vi.fn(() => 'no_replay'),
  classifyActivity: vi.fn(() => 'unknown'),
}));
vi.mock('../facts/persist.js', () => ({ replaceSessionFacts: vi.fn() }));
vi.mock('../friction/persist.js', () => ({ writeFrictionSignals: vi.fn() }));
vi.mock('../friction/promotion.js', () => ({ processFrictionOutcomes: vi.fn() }));
vi.mock('../friction/adjudicator.js', () => ({
  createAnthropicAdjudicator: vi.fn(() => ({ modelId: 'real', promptVersion: 1, adjudicate: vi.fn() })),
}));
vi.mock('../friction/evidence-window.js', () => ({
  EVIDENCE_WINDOW_MS: 15_000,
  buildEvidenceWindows: vi.fn(() => []),
}));

const db = await import('../db.js');
const { cloneRepo } = await import('../repo-clone.js');
const { runPipeline } = await import('../pipeline.js');
const { investigateError } = await import('../investigate.js');
const { processJobInner, processInvestigateJob, processFixJob, processSessionAnalysisJob } = await import('../index.js');
const { gatherFrictionEvidence } = await import('../friction/friction-evidence.js');
const { investigateFriction } = await import('../friction/investigate-friction.js');
const { readChunksBounded } = await import('../friction/chunk-reader.js');
const { analyzeSession } = await import('../friction/analyzer.js');
const { replaceSessionFacts } = await import('../facts/persist.js');
const { writeFrictionSignals } = await import('../friction/persist.js');
const { processFrictionOutcomes } = await import('../friction/promotion.js');
const { processRouteMapJob } = await import('../route-map.js');
const { runProductContext } = await import('../product-context/job.js');
const { runInquiry } = await import('../inquiry/job.js');
const { writeDigest } = await import('../digest-writer/job.js');
const { loadEvidence } = await import('../evidence/bundle.js');
const { processScoreSyncJob } = await import('../score-sync.js');
const { runStackResolve } = await import('../resolve/job.js');
const { pushScore } = await import('../scores.js');
const { getActiveTraceId } = await import('../tracing.js');
const { logger } = await import('../logger.js');

const mockGetErrorGroup = vi.mocked(db.getErrorGroup);
const mockGetErrorEvent = vi.mocked(db.getErrorEvent);
const mockGetProject = vi.mocked(db.getProject);
const mockUpdateGroupStatus = vi.mocked(db.updateGroupStatus);
const mockCloneRepo = vi.mocked(cloneRepo);
const mockRunPipeline = vi.mocked(runPipeline);
const mockInvestigateError = vi.mocked(investigateError);
const mockGetSessionPointerForGroup = vi.mocked(db.getSessionPointerForGroup);
const mockGetPlayableChunkMetas = vi.mocked(db.getPlayableChunkMetas);
const mockLoadEvidence = vi.mocked(loadEvidence);

function makeJob(): ClaimedJob & { errorGroupId: string } {
  return {
    id: 'job-1',
    workerId: 'worker-1',
    errorGroupId: 'grp-1',
    eventId: null,
    episodeId: 'episode-1',
    sourceId: null,
    projectId: 'proj-1',
    jobType: 'investigate',
    attempts: 0,
    guidance: null,
    leaseGeneration: '1',
    triggeredBy: null,
    sessionId: null,
  };
}

function makeEvidence(sourceEventId = 'evt-1'): EvidenceBundle {
  return {
    frames: {
      sourceEventId,
      status: 'resolved',
      resolverVersion: 2,
      envelope: { version: 2, frames: [] },
      commitSha: 'abc123',
    },
    failedRequests: [],
    writeRollups: [],
    productContext: [],
    replayPointers: [],
    availability: { recording: 'missing', sourceMap: 'resolved' },
    affectedUnits: 2,
    relatedCandidates: [],
  };
}

beforeEach(() => {
  mockLoadEvidence.mockResolvedValue(makeEvidence());
});

function makeGroup(overrides?: Partial<ErrorGroupData>): ErrorGroupData {
  return {
    id: 'grp-1',
    title: 'Script error.',
    fingerprint: 'fp-1',
    sample_event_id: 'evt-1',
    occurrence_count: 3,
    status: 'queued',
    kind: 'error',
    signal_type: null,
    element_selector: null,
    page_url_normalized: null,
    confidence: null,
    ...overrides,
  };
}

function makeEvent(stack: string): ErrorEventData {
  return {
    id: 'evt-1',
    error_type: 'Error',
    error_message: 'Script error.',
    stack_trace_raw: stack,
    stack_trace_resolved: null,
    debug_meta: null,
    breadcrumbs: '[]',
    context: '{}',
    release: null,
    session_id: null,
  };
}

/** The needs_human call carrying the unfixable_no_app_frames disposition, if any. */
function unfixableCall() {
  return vi.mocked(db.updateGroupInvestigation).mock.calls.find(
    (c) => c[2] === 'needs_human' && c[3]?.reason?.reason_code === 'unfixable_no_app_frames',
  );
}

describe('processInvestigateJob — pre-clone guard for stackless errors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSessionPointerForGroup.mockResolvedValue(null);
  });

  afterEach(() => {
    delete process.env['OPSLANE_PYTHON_PIPELINE'];
  });

  const pythonTraceback = 'Traceback (most recent call last):\n  File "/app/cart.py", line 11, in total\n    boom()\nTypeError: boom';

  it('opens the Python guard only when the feature flag is enabled', async () => {
    mockGetErrorGroup.mockResolvedValue(makeGroup({ platform: 'python' }));
    mockGetErrorEvent.mockResolvedValue(makeEvent(pythonTraceback));

    await processInvestigateJob(makeJob(), new AbortController().signal);
    expect(unfixableCall()).toBeDefined();

    vi.clearAllMocks();
    process.env['OPSLANE_PYTHON_PIPELINE'] = '1';
    mockGetErrorGroup.mockResolvedValue(makeGroup({ platform: 'python' }));
    mockGetErrorEvent.mockResolvedValue(makeEvent(pythonTraceback));
    mockGetProject.mockResolvedValue(null);

    await expect(processInvestigateJob(makeJob(), new AbortController().signal)).rejects.toThrow(/not found/i);
    expect(unfixableCall()).toBeUndefined();
  });

  it('short-circuits a stackless event to needs_human WITHOUT cloning the repo', async () => {
    mockGetErrorGroup.mockResolvedValue(makeGroup());
    mockGetErrorEvent.mockResolvedValue(makeEvent('')); // empty stack = cross-origin "Script error."

    await processInvestigateJob(makeJob(), new AbortController().signal);

    // The expensive path (repo clone → LLM/sandbox) must never run.
    expect(mockCloneRepo).not.toHaveBeenCalled();

    // The group must be parked as a non-retriable needs_human with the full
    // reason contract (reason_code + reason_message + remediation).
    const call = unfixableCall();
    expect(call).toBeDefined();
    const reason = call![3]?.reason;
    expect(reason?.reason_code).toBe('unfixable_no_app_frames');
    expect(reason?.reason_message).toBeTruthy();
    expect(reason?.remediation).toBeTruthy();
  });

  it('fetches the frozen threshold anchor, not the mutable group sample', async () => {
    mockGetErrorGroup.mockResolvedValue(makeGroup({ sample_event_id: 'evt-sample' }));
    mockLoadEvidence.mockResolvedValue(makeEvidence('evt-anchor'));
    mockGetErrorEvent.mockResolvedValue(makeEvent('')); // stackless: guard exits before clone

    await processInvestigateJob(makeJob(), new AbortController().signal);

    expect(mockLoadEvidence).toHaveBeenCalledWith('proj-1', 'episode-1');
    expect(mockGetErrorEvent).toHaveBeenCalledWith('evt-anchor', 'proj-1');
    expect(mockGetErrorEvent).not.toHaveBeenCalledWith('evt-sample', 'proj-1');
  });

  it('does NOT fire the guard when the stack has real application frames', async () => {
    mockGetErrorGroup.mockResolvedValue(makeGroup());
    mockGetErrorEvent.mockResolvedValue(makeEvent('TypeError: x\n    at Proxy.render (src/App.vue:9:30)'));
    // Force a throw right after the guard (getProject is reached before cloneRepo),
    // proving the flow continued past the guard rather than short-circuiting.
    mockGetProject.mockResolvedValue(null);

    await expect(processInvestigateJob(makeJob(), new AbortController().signal)).rejects.toThrow(/not found/i);

    // The stackless disposition must NOT have been applied to a real app-frame error.
    expect(unfixableCall()).toBeUndefined();
  });

  it('treats a missing anchored event as unfixable without using the sample', async () => {
    mockGetErrorGroup.mockResolvedValue(makeGroup({ sample_event_id: '' }));
    mockGetErrorEvent.mockResolvedValue(null);

    await processInvestigateJob(makeJob(), new AbortController().signal);

    expect(mockGetErrorEvent).toHaveBeenCalledWith('evt-1', 'proj-1');
    expect(mockCloneRepo).not.toHaveBeenCalled();
    expect(unfixableCall()).toBeDefined();
  });

  it('adopts an already-started fix instead of re-running a recovered investigation', async () => {
    mockGetErrorGroup.mockResolvedValue(makeGroup({ status: 'fixing' }));

    await processInvestigateJob(makeJob(), new AbortController().signal);

    expect(mockUpdateGroupStatus).not.toHaveBeenCalled();
    expect(mockGetErrorEvent).not.toHaveBeenCalled();
    expect(mockCloneRepo).not.toHaveBeenCalled();
  });
});

describe('processInvestigateJob diagnosis routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveTraceId).mockReturnValue(null);
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
    process.env['GITHUB_TOKEN'] = 'test-token';
    mockGetSessionPointerForGroup.mockResolvedValue(null);
    mockGetErrorGroup.mockResolvedValue(makeGroup({
      status: 'analyzing',
      title: 'TypeError: x',
    }));
    mockGetErrorEvent.mockResolvedValue(makeEvent('TypeError: x\n    at src/App.vue:42:1'));
    mockGetProject.mockResolvedValue({
      id: 'proj-1',
      name: 'demo',
      github_repo: 'org/demo',
      default_branch: 'main',
      friction_autonomy: 'ask_first',
    });
    vi.mocked(db.getProjectGitHubInstallation).mockResolvedValue(null);
      mockCloneRepo.mockResolvedValue({
      repoDir: '/tmp/repo',
      defaultBranch: 'main',
      headSha: 'abc123',
      cleanup: vi.fn(),
    });
  });

  afterEach(() => {
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['GITHUB_TOKEN'];
  });

  it('does not persist the internal report-ready phrase on any terminal path', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('Investigation report ready');
  });

  it('keeps an accepted external cause as an insight with a terminal human outcome', async () => {
    mockInvestigateError.mockResolvedValue({
      fixable: false,
      confidence: 'medium',
      reason: 'The cause is outside this codebase: GET /api/assets/search (remote service)',
      adjudication: {
        best_supported: 'The remote search endpoint exceeded its response budget',
        evidence_check: 'checked', candidates_considered: [], rejected: [], rejected_candidates: [],
        evidence_strength: 'suggestive', cause_kind: 'external_system', cause_locations: [],
        reasoning: 'remote failure', why_chain: [], reproduction_steps: [],
      },
      dispositions: [
        { id: 'c1', disposition: 'ungrounded' },
        { id: 'c2', disposition: 'rejected' },
      ],
      costUsd: 0.12,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      decisionReason: 'The cause is outside this codebase: GET /api/assets/search (remote service)',
      decisionBasis: 'cause_outside_codebase',
      outcome: 'not_actionable',
      diagnosis: {
        one_line_description: 'The search endpoint exceeded its 10 second budget',
        why_chain: ['User types', 'Client calls the endpoint', 'No response in 10s'],
        reproduction_steps: ['Search a common term'],
        cause_location: 'GET /api/assets/search (remote service)',
      },
      filesRead: [],
      findings: '',
      evidence: [], agentTaskBrief: null, investigatedCommit: 'abc123',
      stop: 'terminal',
    });

    await processInvestigateJob(makeJob(), new AbortController().signal);

    expect(db.updateGroupInvestigation).toHaveBeenCalledWith(
      'grp-1', 'proj-1', 'insight', expect.objectContaining({
        rootCause: 'The search endpoint exceeded its 10 second budget',
        decision: expect.objectContaining({
          jobId: 'job-1',
          outcome: 'needs_human',
          causeLocation: 'GET /api/assets/search (remote service)',
          promptVersion: 'diagnosis-v1',
          causeKind: 'external_system',
          dispositions: [
            { id: 'c1', disposition: 'ungrounded' },
            { id: 'c2', disposition: 'rejected' },
          ],
        }),
        reason: expect.objectContaining({ reason_code: 'unfixable_third_party' }),
      }), makeJob(),
    );
    expect(db.updateGroupAndCreateFixJob).not.toHaveBeenCalled();
    expect(db.recordJobUsage).toHaveBeenCalledWith({
      jobId: 'job-1',
      execution: 0,
      phase: 'investigation',
      model: 'claude-sonnet-5',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0.12,
    });
  });

  function apiFailureResult(over: Record<string, unknown>) {
    return {
      fixable: false,
      confidence: 'low' as const,
      reason: 'Investigation could not reach the model',
      adjudication: null,
      costUsd: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      decisionBasis: 'no_adjudication' as const,
      decisionReason: 'Investigation could not reach the model',
      outcome: 'needs_more_context' as const,
      diagnosis: null,
      filesRead: [],
      findings: '',
      evidence: [],
      agentTaskBrief: null,
      investigatedCommit: 'abc123',
      stop: 'api_error' as const,
      ...over,
    };
  }

  it('fails the job on a deterministic 4xx instead of writing a customer terminal', async () => {
    mockInvestigateError.mockResolvedValue(apiFailureResult({
      apiErrorStatus: 400,
      apiErrorDetail: "tools.3.custom: For 'array' type, property 'maxItems' is not supported",
    }) as never);

    await expect(processInvestigateJob(makeJob(), new AbortController().signal))
      .rejects.toThrow('Investigation model request rejected (HTTP 400)');

    expect(db.updateGroupInvestigation).not.toHaveBeenCalled();
    expect(db.updateGroupAndCreateFixJob).not.toHaveBeenCalled();
  });

  it('retries a transient model failure while the job has retry budget left', async () => {
    mockInvestigateError.mockResolvedValue(apiFailureResult({
      apiErrorStatus: 529,
      apiErrorDetail: 'overloaded',
    }) as never);

    await expect(processInvestigateJob(makeJob(), new AbortController().signal))
      .rejects.toThrow('Investigation model unavailable (HTTP 529)');

    expect(db.updateGroupInvestigation).not.toHaveBeenCalled();
  });

  it('terminalizes a transient model failure only when the retry budget is exhausted', async () => {
    mockInvestigateError.mockResolvedValue(apiFailureResult({
      apiErrorStatus: 529,
      apiErrorDetail: 'overloaded',
    }) as never);
    const job = { ...makeJob(), attempts: 2, maxAttempts: 3 };

    await processInvestigateJob(job, new AbortController().signal);

    expect(db.updateGroupInvestigation).toHaveBeenCalledWith(
      'grp-1', 'proj-1', 'needs_human', expect.objectContaining({
        decision: expect.objectContaining({ outcome: 'unable_to_establish_cause' }),
      }), job,
    );
  });

  it('treats an oversized prompt as an evidence condition, not an operator failure', async () => {
    mockInvestigateError.mockResolvedValue(apiFailureResult({
      apiErrorStatus: 400,
      apiErrorDetail: 'prompt is too long: 250000 tokens > 200000 maximum',
    }) as never);

    await processInvestigateJob(makeJob(), new AbortController().signal);

    expect(db.updateGroupInvestigation).toHaveBeenCalledWith(
      'grp-1', 'proj-1', 'needs_human', expect.objectContaining({
        decision: expect.objectContaining({ outcome: 'unable_to_establish_cause' }),
      }), makeJob(),
    );
  });

  it('fails the job on a transient clone failure instead of writing a terminal', async () => {
    mockCloneRepo.mockRejectedValueOnce(new Error('fatal: unable to access repo: Connection timed out'));

    await expect(processInvestigateJob(makeJob(), new AbortController().signal))
      .rejects.toThrow('Connection timed out');

    expect(db.updateGroupInvestigation).not.toHaveBeenCalled();
  });

  it('records the checked-out commit on the job row before the model runs', async () => {
    mockInvestigateError.mockResolvedValue(apiFailureResult({
      apiErrorStatus: 400,
      apiErrorDetail: 'tools.3.custom: maxItems',
    }) as never);

    await expect(processInvestigateJob(makeJob(), new AbortController().signal)).rejects.toThrow();

    expect(db.recordInvestigatedCommit).toHaveBeenCalledWith(makeJob(), 'abc123');
  });

  it('routes needs_more_context to needs_human with a complete reason', async () => {
    mockInvestigateError.mockResolvedValue({
      fixable: false,
      confidence: 'low',
      reason: 'The investigation produced no usable diagnosis',
      adjudication: null,
      costUsd: 0.12,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      decisionBasis: 'insufficient_evidence',
        decisionReason: 'The investigation produced no usable diagnosis',
      outcome: 'needs_more_context',
      diagnosis: null,
      filesRead: [],
      findings: '',
      evidence: [], agentTaskBrief: null, investigatedCommit: 'abc123',
      stop: 'terminal',
    });

    await processInvestigateJob(makeJob(), new AbortController().signal);

    expect(db.updateGroupInvestigation).toHaveBeenCalledWith(
      'grp-1', 'proj-1', 'needs_human', expect.objectContaining({
        // decisionReason is model-derived prose from an unvalidated verdict.
        // reason_message renders ungated on the incident page, so it must be
        // computed copy; the prose lives only in the decision row.
        rootCause: null,
        reason: {
          reason_code: 'insufficient_context',
          reason_message: 'The investigation could not establish a verified cause from the available evidence.',
          remediation: expect.any(String),
        },
        decision: expect.objectContaining({
          jobId: 'job-1',
          outcome: 'unable_to_establish_cause',
          diagnosis: null,
        }),
      }), makeJob(),
    );
  });

  it('persists an invalid adjudication as terminal needs_human without creating a fix job', async () => {
    mockInvestigateError.mockResolvedValue({
      fixable: false,
      confidence: 'low',
      reason: 'duplicate_candidate_id: c1',
      adjudication: null,
      costUsd: 0.01,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      decisionReason: 'duplicate_candidate_id: c1',
      decisionBasis: 'invalid_verdict',
      outcome: 'incomplete',
      diagnosis: null,
      filesRead: ['src/App.vue'],
      findings: '', evidence: [], agentTaskBrief: null, investigatedCommit: 'abc123',
      stop: 'terminal',
    });

    await processInvestigateJob(makeJob(), new AbortController().signal);

    expect(db.updateGroupInvestigation).toHaveBeenCalledWith(
      'grp-1', 'proj-1', 'needs_human', expect.objectContaining({
        reason: expect.objectContaining({ reason_code: 'insufficient_context' }),
        decision: expect.objectContaining({
          outcome: 'unable_to_establish_cause', basis: 'invalid_verdict',
          decisionReason: 'duplicate_candidate_id: c1',
        }),
      }), makeJob(),
    );
    expect(db.updateGroupAndCreateFixJob).not.toHaveBeenCalled();
  });

  it('creates a fix job from a high-confidence code diagnosis without suggested mitigation', async () => {
    mockInvestigateError.mockResolvedValue({
      fixable: true,
      confidence: 'high',
      reason: 'The cause is at src/App.vue:42',
      adjudication: null,
      costUsd: 0.12,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      decisionReason: 'The cause is at src/App.vue:42',
      decisionBasis: 'local_defect',
      outcome: 'code_fix',
      diagnosis: {
        one_line_description: 'Null dereference rendering the asset list',
        why_chain: ['Render runs before fetch resolves', 'assets is null', 'map throws'],
        reproduction_steps: ['Open the panel on a slow connection'],
        cause_location: 'src/App.vue:42',
      },
      filesRead: [],
      findings: '',
      evidence: [], agentTaskBrief: null, investigatedCommit: 'abc123',
      stop: 'terminal',
    });
    vi.mocked(db.updateGroupAndCreateFixJob).mockResolvedValue({ created: true, fixJobId: 'fix-1' });

    await processInvestigateJob(makeJob(), new AbortController().signal);

    const fields = vi.mocked(db.updateGroupAndCreateFixJob).mock.calls[0]?.[2];
    expect(fields).toMatchObject({
      rootCause: 'Null dereference rendering the asset list',
      diagnosis: expect.objectContaining({ cause_location: 'src/App.vue:42' }),
      decision: expect.objectContaining({
        jobId: 'job-1',
        outcome: 'code_fix',
        causeLocation: 'src/App.vue:42',
      }),
      sourceJobId: 'job-1',
    });
    expect(fields).not.toHaveProperty('suggestedMitigation');
  });

  it('pushes diagnosis scores only after the durable outcome write', async () => {
    vi.mocked(getActiveTraceId).mockReturnValue('trace-1');
    mockInvestigateError.mockResolvedValue({
      fixable: false,
      confidence: 'medium',
      reason: 'The cause is outside this codebase',
      adjudication: null,
      costUsd: 0.01,
      usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
      decisionReason: 'The cause is outside this codebase',
      decisionBasis: 'cause_outside_codebase',
      outcome: 'not_actionable',
      diagnosis: null,
      filesRead: [],
      findings: '',
      evidence: [], agentTaskBrief: null, investigatedCommit: 'abc123',
      stop: 'terminal',
    });

    await processInvestigateJob(makeJob(), new AbortController().signal);

    expect(pushScore).toHaveBeenNthCalledWith(1, {
      traceId: 'trace-1',
      name: 'diagnosis_outcome',
      value: 'not_actionable',
      dataType: 'CATEGORICAL',
      id: 'diagnosis-outcome-job-1-0',
    });
    expect(pushScore).toHaveBeenNthCalledWith(2, {
      traceId: 'trace-1',
      name: 'diagnosis_confidence',
      value: 'medium',
      dataType: 'CATEGORICAL',
      id: 'diagnosis-confidence-job-1-0',
    });
    expect(
      vi.mocked(db.updateGroupInvestigation).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(pushScore).mock.invocationCallOrder[0]!);
  });

  it('a rejected diagnosis score push never fails the investigation job', async () => {
    vi.mocked(getActiveTraceId).mockReturnValue('trace-1');
    vi.mocked(pushScore).mockRejectedValue(new Error('Langfuse score rejected: 503'));
    mockInvestigateError.mockResolvedValue({
      fixable: false,
      confidence: 'medium',
      reason: 'The cause is outside this codebase',
      adjudication: null,
      costUsd: 0.01,
      usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
      decisionReason: 'The cause is outside this codebase',
      decisionBasis: 'cause_outside_codebase',
      outcome: 'not_actionable',
      diagnosis: null,
      filesRead: [],
      findings: '',
      evidence: [], agentTaskBrief: null, investigatedCommit: 'abc123',
      stop: 'terminal',
    });

    await expect(
      processInvestigateJob(makeJob(), new AbortController().signal),
    ).resolves.toBeUndefined();
    expect(pushScore).toHaveBeenCalled();
    expect(db.updateGroupInvestigation).toHaveBeenCalled();
  });

  it('does not reapply the removed impact bar after inquiry acceptance', async () => {
    vi.mocked(db.getGroupImpactBar).mockResolvedValueOnce({
      identifiedUsers: 0,
      recentAnonSessions: 2,
      eligible: false,
    });
    mockInvestigateError.mockResolvedValue({
      fixable: true,
      confidence: 'medium',
      reason: 'The cause is at src/App.vue:42',
      adjudication: null,
      costUsd: 0.12,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      decisionReason: 'The cause is at src/App.vue:42',
      decisionBasis: 'local_defect',
      outcome: 'code_fix',
      diagnosis: {
        one_line_description: 'Null dereference rendering the asset list',
        why_chain: ['Render runs before fetch resolves'],
        reproduction_steps: ['Open the panel on a slow connection'],
        cause_location: 'src/App.vue:42',
      },
      filesRead: [],
      findings: '',
      evidence: [], agentTaskBrief: null, investigatedCommit: 'abc123',
      stop: 'terminal',
    });
    vi.mocked(db.updateGroupAndCreateFixJob).mockResolvedValue({ created: true, fixJobId: 'fix-1' });

    await processInvestigateJob(makeJob(), new AbortController().signal);

    expect(db.getGroupImpactBar).not.toHaveBeenCalled();
    expect(db.updateGroupAndCreateFixJob).toHaveBeenCalledWith(
      'grp-1', 'proj-1', expect.objectContaining({
        decision: expect.objectContaining({ policyEligible: true, policyBasis: null }),
      }), makeJob(),
    );
  });

  it('parks a kind-gate refusal without losing decision provenance', async () => {
    mockInvestigateError.mockResolvedValue({
      fixable: true, confidence: 'high', reason: 'The cause is at src/App.vue', adjudication: null,
      costUsd: 0.1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      decisionReason: 'The cause is at src/App.vue', decisionBasis: 'local_defect', outcome: 'code_fix',
      diagnosis: { one_line_description: 'Disconnected save handler', why_chain: [], reproduction_steps: [], cause_location: 'src/App.vue' },
      filesRead: ['src/App.vue'], findings: '', stop: 'terminal', evidence: [], agentTaskBrief: 'wire it', investigatedCommit: 'abc123',
    });
    vi.mocked(db.updateGroupAndCreateFixJob).mockResolvedValue({ created: false, reason: 'kind_not_error' });

    await processInvestigateJob(makeJob(), new AbortController().signal);

    expect(db.updateGroupInvestigation).toHaveBeenCalledWith(
      'grp-1', 'proj-1', 'investigated', expect.objectContaining({
        decision: expect.objectContaining({ jobId: 'job-1', outcome: 'needs_human' }),
      }), makeJob(),
    );
  });
});

describe('processFixJob — preserves writeup on failure (no revert/null)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSessionPointerForGroup.mockResolvedValue(null);
    mockGetPlayableChunkMetas.mockResolvedValue([]);
    mockGetErrorGroup.mockResolvedValue({
      id: 'g1', title: 'Null deref', fingerprint: 'fp', sample_event_id: 'e1',
      occurrence_count: 3, status: 'fixing',
    } as ErrorGroupData);
    mockGetErrorEvent.mockResolvedValue({
      id: 'e1', error_type: 'TypeError', error_message: 'x of undefined',
      stack_trace_raw: 'at App.vue:42', stack_trace_resolved: null,
      debug_meta: null,
      breadcrumbs: '[]', context: '{}', release: null, session_id: null,
    } as ErrorEventData);
    mockGetProject.mockResolvedValue({
      id: 'p1', name: 'app', github_repo: 'org/app', default_branch: 'main', friction_autonomy: 'ask_first',
    } as ProjectData);
    mockCloneRepo.mockResolvedValue({
      repoDir: '/tmp/r',
      defaultBranch: 'master',
      headSha: 'abc123',
      cleanup: vi.fn(),
    } as never);
    vi.mocked(db.getProjectGitHubInstallation).mockResolvedValue(null as never);
    vi.mocked(db.getReplayForGroup).mockResolvedValue(null as never);
    vi.mocked(db.getReplayArtifacts).mockResolvedValue([] as never);
    vi.mocked(db.getSourceMapRows).mockResolvedValue([] as never);
    vi.mocked(db.getGroupInvestigation).mockResolvedValue({ rootCause: 'null deref in App.vue', suggestedMitigation: 'guard' });
    process.env['GITHUB_TOKEN'] = 'gh-test';
  });

  function fixJob(): ClaimedJob & { errorGroupId: string } {
    return {
      id: 'j1',
      workerId: 'worker-1',
      errorGroupId: 'g1',
      eventId: null,
      episodeId: 'episode-1',
      sourceId: null,
      projectId: 'p1',
      jobType: 'fix',
      attempts: 0,
      guidance: null,
      leaseGeneration: '1',
      triggeredBy: null,
      sessionId: null,
    };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env['INGESTION_BASE_URL'];
    delete process.env['INTERNAL_READ_TOKEN'];
    delete process.env['OPSLANE_PYTHON_PIPELINE'];
  });

  it('adopts a terminal result only when this fix job owns its marker', async () => {
    mockGetErrorGroup.mockResolvedValue({
      ...makeGroup({ id: 'g1', status: 'pr_draft' }),
      terminal_fix_job_id: 'j1',
    });

    await processFixJob(fixJob(), new AbortController().signal);

    expect(mockRunPipeline).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      'Fix delivery already committed; adopting existing state',
      expect.objectContaining({ job_id: 'j1' }),
    );
  });

  it('does not adopt or overwrite a terminal result owned by another fix job', async () => {
    mockGetErrorGroup.mockResolvedValue({
      ...makeGroup({ id: 'g1', status: 'needs_human' }),
      terminal_fix_job_id: 'newer-fix-job',
    });

    await processFixJob(fixJob(), new AbortController().signal);

    expect(mockRunPipeline).not.toHaveBeenCalled();
    expect(mockUpdateGroupStatus).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'Refused terminal state owned by another fix job',
      expect.objectContaining({ job_id: 'j1', terminal_fix_job_id: 'newer-fix-job' }),
    );
  });

  it('fails the fix job on a transient clone failure instead of writing a terminal', async () => {
    mockCloneRepo.mockRejectedValueOnce(new Error('fatal: unable to access repo: Connection timed out'));

    await expect(processFixJob(fixJob(), new AbortController().signal))
      .rejects.toThrow('Connection timed out');

    expect(mockUpdateGroupStatus).not.toHaveBeenCalled();
    expect(mockRunPipeline).not.toHaveBeenCalled();
  });

  it('refuses an error fix job without frozen episode evidence', async () => {
    await expect(processFixJob(
      { ...fixJob(), episodeId: null },
      new AbortController().signal,
    )).rejects.toThrow('Error fix job j1 missing episode_id');

    expect(mockLoadEvidence).not.toHaveBeenCalled();
    expect(mockRunPipeline).not.toHaveBeenCalled();
  });

  it('terminates as needs_human with all reason fields + confidence when the fix is below floor', async () => {
    mockRunPipeline.mockResolvedValue({
      status: 'needs_human',
      confidence: 'medium',
      reason: {
        reason_code: 'low_confidence_fix',
        reason_message: 'Candidate fix could not be verified',
        remediation: 'Review the candidate diff manually',
      },
    });

    await processFixJob(fixJob(), new AbortController().signal);

    const call = mockUpdateGroupStatus.mock.calls.find((c) => c[2] === 'needs_human');
    expect(call, 'expected an updateGroupStatus(needs_human) call').toBeTruthy();
    expect(call![3]?.reason?.reason_code).toBe('low_confidence_fix');
    expect(call![3]?.reason?.reason_message).toBeTruthy();
    expect(call![3]?.reason?.remediation).toBeTruthy();
    expect(call![3]?.confidence).toBe('medium');
    expect(db.recordFixTerminalDecision).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'needs_human',
      reason: expect.stringContaining('Required action:'),
    }));
  });

  it('sets pr_created on a successful high-confidence fix', async () => {
    mockRunPipeline.mockResolvedValue({
      status: 'pr_created', confidence: 'high',
      pr_url: 'https://github.com/org/app/pull/7', pr_number: 7, head_sha: 'head-7',
    });

    await processFixJob(fixJob(), new AbortController().signal);

    const call = vi.mocked(db.finalizeDelivery).mock.calls[0];
    expect(call).toBeTruthy();
    expect(call![2]).toEqual(expect.objectContaining({
      status: 'pr_created',
      prUrl: 'https://github.com/org/app/pull/7',
      prNumber: 7,
      headSha: 'head-7',
      fixJobId: 'j1',
    }));
    expect(db.recordFixTerminalDecision).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'verified_fix',
      reason: expect.not.stringContaining('Investigation report ready'),
    }));
  });

  it('keeps persisted Python routing after the feature flag is disabled', async () => {
    process.env['OPSLANE_PYTHON_PIPELINE'] = '0';
    mockGetErrorGroup.mockResolvedValue({
      ...makeGroup({ id: 'g1', sample_event_id: 'e1', status: 'fixing', platform: 'python' }),
    });
    mockGetErrorEvent.mockResolvedValue({
      ...makeEvent('Traceback (most recent call last):\n  File "/app/cart.py", line 1, in total\n    boom()\nTypeError: boom'),
      id: 'e1', context: '{"runtime":{"name":"CPython","version":"3.11.8"}}', release: 'r1',
    });
    mockRunPipeline.mockResolvedValue({
      status: 'needs_human',
      reason: { reason_code: 'tests_failed', reason_message: 'failed', remediation: 'review' },
    });

    await processFixJob({ ...fixJob(), platform: 'python' }, new AbortController().signal);

    expect(mockRunPipeline).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'python',
      customerRuntime: { name: 'CPython', version: '3.11.8' },
    }));
    expect(db.getSourceMapRows).not.toHaveBeenCalled();
  });

  it('rethrows verification infrastructure errors while the job has retries remaining', async () => {
    const evidence = {
      version: 1 as const,
      tier: null,
      checks: [{ name: 'sandbox', outcome: 'infra_error' as const, command: '', output_tail: 'gone' }],
    };
    mockRunPipeline.mockRejectedValue(new VerificationInfraError('runner crashed', evidence));

    await expect(processJobInner(
      { ...fixJob(), attempts: 0, maxAttempts: 3 },
      new AbortController().signal,
    )).rejects.toBeInstanceOf(VerificationInfraError);

    expect(mockUpdateGroupStatus.mock.calls.some(
      (call) => call[3]?.reason?.reason_code === 'verification_infra_error',
    )).toBe(false);
  });

  it('converts a final verification infrastructure failure to needs_human with evidence', async () => {
    const evidence = {
      version: 1 as const,
      tier: null,
      checks: [{ name: 'sandbox', outcome: 'infra_error' as const, command: '', output_tail: 'gone' }],
    };
    mockRunPipeline.mockRejectedValue(new VerificationInfraError('runner crashed', evidence));

    await processJobInner(
      { ...fixJob(), attempts: 2, maxAttempts: 3 },
      new AbortController().signal,
    );

    const call = mockUpdateGroupStatus.mock.calls.find(
      (entry) => entry[3]?.reason?.reason_code === 'verification_infra_error',
    );
    expect(call?.[2]).toBe('needs_human');
    expect(call?.[3]?.evidence).toEqual(evidence);
    expect(call?.[3]?.evidence?.checks).toHaveLength(1);
  });

  it('logs when persisting trace_url rejects instead of swallowing it', async () => {
    const { getActiveTraceId, buildLangfuseTraceUrl } = await import('../tracing.js');
    const { updateJobTraceUrl } = await import('../db.js');
    const { logger } = await import('../logger.js');

    vi.mocked(getActiveTraceId).mockReturnValueOnce('trace-abc');
    vi.mocked(buildLangfuseTraceUrl).mockReturnValueOnce('https://lf.example/traces/trace-abc');
    vi.mocked(updateJobTraceUrl).mockRejectedValueOnce(new Error('db down'));
    mockRunPipeline.mockResolvedValue({
      status: 'needs_human',
      reason: { reason_code: 'tests_failed', reason_message: 'failed', remediation: 'review' },
    });

    // Same job fixture shape as the neighbouring processJobInner tests.
    const job = fixJob();
    await processJobInner(job, new AbortController().signal);

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('Failed to persist trace_url', {
      job_id: job.id,
      error: 'db down',
    });
  });

  it('uses the frozen replay pointer fetched through ingestion', async () => {
    const errorAt = '2026-07-15T12:00:00.000Z';
    const errorAtMs = Date.parse(errorAt);
    mockLoadEvidence.mockResolvedValue({
      ...makeEvidence(),
      replayPointers: [{
        anchorKind: 'threshold', eventId: 'evt-1', sessionId: 'sess/a', anchorMs: errorAtMs,
      }],
      availability: { recording: 'available', sourceMap: 'resolved' },
    });
    mockGetPlayableChunkMetas.mockResolvedValue([{
      seq: 3,
      size_bytes: 100,
      decoded_size_bytes: 500,
      has_full_snapshot: true,
      first_event_ms: errorAtMs - 1_000,
      last_event_ms: errorAtMs + 1_000,
    }]);
    process.env['INGESTION_BASE_URL'] = 'http://ingestion:8080';
    process.env['INTERNAL_READ_TOKEN'] = 'secret';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ events: [
      { type: 2, timestamp: errorAtMs - 500, data: { node: {
        type: 0, id: 1, childNodes: [{
          type: 2, tagName: 'button', id: 2,
          childNodes: [{ type: 3, id: 3, textContent: 'Save profile' }],
        }],
      } } },
      { type: 3, timestamp: errorAtMs - 100, data: { source: 2, type: 2, id: 2 } },
    ] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    mockRunPipeline.mockResolvedValue({
      status: 'pr_created', confidence: 'high', pr_url: 'https://github.com/org/app/pull/8', pr_number: 8,
      head_sha: 'head-8',
    });

    await processFixJob(fixJob(), new AbortController().signal);

    expect(mockGetSessionPointerForGroup).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://ingestion:8080/internal/v1/projects/p1/sessions/sess%2Fa/chunks/3',
    );
    expect(fetchMock.mock.calls[0]?.[1]).toEqual({ headers: { 'X-Internal-Token': 'secret' } });
    const pipelineInput = mockRunPipeline.mock.calls[0]?.[0];
    expect(pipelineInput?.visualAnalysis?.failureMoment).toContain('Save profile');
  });
});

describe('friction worker path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
    mockGetErrorGroup.mockResolvedValue(makeGroup({
      kind: 'friction',
      status: 'candidate',
      sample_event_id: '',
      signal_type: 'dead_click',
      element_selector: '[data-testid="save"]',
      page_url_normalized: 'https://app.example.com/settings',
    }));
    mockGetProject.mockResolvedValue({
      id: 'proj-1', name: 'app', github_repo: 'org/app', default_branch: 'main', friction_autonomy: 'ask_first',
    });
    vi.mocked(db.getProjectGitHubInstallation).mockResolvedValue(null);
    mockCloneRepo.mockResolvedValue({ repoDir: '/tmp/repo', defaultBranch: 'main', headSha: 'abc123', cleanup: vi.fn() });
    vi.mocked(gatherFrictionEvidence).mockResolvedValue({ signals: [], timeline: '', truncated: false });
    mockRunPipeline.mockResolvedValue({
      status: 'pr_created', confidence: 'high', pr_url: 'https://github.com/org/app/pull/9', pr_number: 9,
      head_sha: 'head-9',
    });
  });

  it('parks code-caused friction under ask-first autonomy', async () => {
    vi.mocked(investigateFriction).mockResolvedValue({
      status: 'verdict', investigatedCommit: 'abc123', costUsd: 0.1,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      verdict: { codeCause: true, confidence: 'high', reason: 'save handler is disconnected', remediation: 'wire the handler', evidence: [], agentTaskBrief: 'wire it' },
    });

    await processInvestigateJob(makeJob(), new AbortController().signal);

    expect(mockGetErrorEvent).not.toHaveBeenCalled();
    expect(db.getReplayForGroup).not.toHaveBeenCalled();
    expect(db.getSourceMapRows).not.toHaveBeenCalled();
    expect(db.updateGroupAndCreateFixJob).not.toHaveBeenCalled();
    expect(db.updateGroupInvestigation).toHaveBeenCalledWith(
      'grp-1', 'proj-1', 'awaiting_approval', expect.objectContaining({ confidence: 'high' }),
      makeJob(),
    );
  });

  it.each(['auto_fix', 'auto_fix_ux'] as const)(
    'auto-triggers a high-confidence friction fix under %s autonomy', async (frictionAutonomy) => {
      mockGetProject.mockResolvedValue({
        id: 'proj-1', name: 'app', github_repo: 'org/app', default_branch: 'main', friction_autonomy: frictionAutonomy,
      });
      vi.mocked(investigateFriction).mockResolvedValue({
        status: 'verdict', investigatedCommit: 'abc123', costUsd: 0.1,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        verdict: { codeCause: true, confidence: 'high', reason: 'save handler is disconnected', remediation: 'wire the handler', evidence: [], agentTaskBrief: 'wire it' },
      });
      vi.mocked(db.updateGroupAndCreateFixJob).mockResolvedValue({ created: true, fixJobId: 'fix-job-1' });

      await processInvestigateJob(makeJob(), new AbortController().signal);

      expect(db.updateGroupAndCreateFixJob).toHaveBeenCalledWith(
        'grp-1', 'proj-1', expect.objectContaining({ confidence: 'high' }), makeJob(),
        { allowFriction: true },
      );
      expect(db.updateGroupInvestigation).not.toHaveBeenCalledWith(
        'grp-1', 'proj-1', 'awaiting_approval', expect.anything(), expect.anything(),
      );
    },
  );

  it('routes identical code-caused friction verdicts identically regardless of confidence', async () => {
    mockGetProject.mockResolvedValue({
      id: 'proj-1', name: 'app', github_repo: 'org/app', default_branch: 'main', friction_autonomy: 'auto_fix',
    });
    vi.mocked(db.updateGroupAndCreateFixJob).mockResolvedValue({ created: true, fixJobId: 'fix-job' });
    for (const confidence of ['high', 'low'] as const) {
      vi.mocked(investigateFriction).mockResolvedValueOnce({
        status: 'verdict', investigatedCommit: 'abc123', costUsd: 0.1,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        verdict: { codeCause: true, confidence, reason: 'save handler is disconnected', remediation: 'wire the handler', evidence: [], agentTaskBrief: 'wire it' },
      });
      await processInvestigateJob(makeJob(), new AbortController().signal);
    }

    expect(db.updateGroupAndCreateFixJob).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(db.updateGroupAndCreateFixJob).mock.calls) {
      expect(call[2].decision).toMatchObject({
        policyEligible: true,
        policyBasis: { v: 1, identified_users: 5, recent_anon_sessions: 0 },
      });
    }
  });

  it('parks below-bar code-caused friction with its policy basis', async () => {
    mockGetProject.mockResolvedValue({
      id: 'proj-1', name: 'app', github_repo: 'org/app', default_branch: 'main', friction_autonomy: 'auto_fix',
    });
    vi.mocked(db.getFrictionGroupImpactBar).mockResolvedValueOnce({ identifiedUsers: 0, recentAnonSessions: 1, eligible: false });
    vi.mocked(investigateFriction).mockResolvedValue({
      status: 'verdict', investigatedCommit: 'abc123', costUsd: 0.1,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      verdict: { codeCause: true, confidence: 'high', reason: 'save handler is disconnected', remediation: 'wire the handler', evidence: [], agentTaskBrief: 'wire it' },
    });

    await processInvestigateJob(makeJob(), new AbortController().signal);

    expect(db.updateGroupAndCreateFixJob).not.toHaveBeenCalled();
    expect(db.updateGroupInvestigation).toHaveBeenCalledWith(
      'grp-1', 'proj-1', 'awaiting_approval', expect.objectContaining({
        decision: expect.objectContaining({
          policyEligible: false,
          policyBasis: { v: 1, identified_users: 0, recent_anon_sessions: 1 },
        }),
      }), makeJob(),
    );
  });

  it('records friction without a code cause as an insight', async () => {
    vi.mocked(investigateFriction).mockResolvedValue({
      status: 'verdict', investigatedCommit: 'abc123', costUsd: 0.1,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      verdict: { codeCause: false, confidence: 'medium', reason: 'The workflow is confusing but functional.', evidence: [], agentTaskBrief: null },
    });

    await processInvestigateJob(makeJob(), new AbortController().signal);

    expect(db.updateGroupInvestigation).toHaveBeenCalledWith(
      'grp-1', 'proj-1', 'insight', expect.objectContaining({ rootCause: expect.any(String) }),
      makeJob(),
    );
    expect(db.updateGroupAndCreateFixJob).not.toHaveBeenCalled();
  });

  it('refuses an auto friction fix under ask-first while preserving confidence', async () => {
    mockGetErrorGroup.mockResolvedValue(makeGroup({
      kind: 'friction', status: 'fixing', sample_event_id: '', confidence: 'high',
    }));
    const job = { ...makeJob(), jobType: 'fix' as const, triggeredBy: 'auto' as const };

    await processFixJob(job, new AbortController().signal);

    expect(mockUpdateGroupStatus).toHaveBeenCalledWith(
      'grp-1', 'proj-1', 'awaiting_approval', expect.objectContaining({ confidence: 'high' }), job,
    );
    expect(mockCloneRepo).not.toHaveBeenCalled();
    expect(mockRunPipeline).not.toHaveBeenCalled();
  });

  it('processes an auto friction fix when autonomy allows it', async () => {
    mockGetErrorGroup.mockResolvedValue(makeGroup({
      kind: 'friction', status: 'fixing', sample_event_id: '', confidence: 'high',
    }));
    mockGetProject.mockResolvedValue({
      id: 'proj-1', name: 'app', github_repo: 'org/app', default_branch: 'main', friction_autonomy: 'auto_fix',
    });
    const job = { ...makeJob(), jobType: 'fix' as const, triggeredBy: 'auto' as const };

    await processFixJob(job, new AbortController().signal);

    expect(mockCloneRepo).toHaveBeenCalled();
  });

  it('parks a legacy friction fix job with no attribution even under auto_fix', async () => {
    mockGetErrorGroup.mockResolvedValue(makeGroup({
      kind: 'friction', status: 'fixing', sample_event_id: '', confidence: 'high',
    }));
    mockGetProject.mockResolvedValue({
      id: 'proj-1', name: 'app', github_repo: 'org/app', default_branch: 'main', friction_autonomy: 'auto_fix',
    });
    const job = { ...makeJob(), jobType: 'fix' as const, triggeredBy: null };

    await processFixJob(job, new AbortController().signal);

    expect(mockUpdateGroupStatus).toHaveBeenCalledWith(
      'grp-1', 'proj-1', 'awaiting_approval', expect.objectContaining({ confidence: 'high' }), job,
    );
    expect(mockCloneRepo).not.toHaveBeenCalled();
  });
});

describe('route_map dispatch', () => {
  it('dispatches project-scoped jobs before the error-group-required guard', async () => {
    const job: ClaimedJob = {
      id: 'route-map-1', workerId: 'worker-1', leaseGeneration: '1',
      errorGroupId: null, eventId: null, sourceId: null, projectId: 'proj-1',
      jobType: 'route_map', attempts: 0, guidance: null, triggeredBy: 'auto', sessionId: null,
    };
    const signal = new AbortController().signal;

    await expect(processJobInner(job, signal)).resolves.toBeUndefined();

    expect(processRouteMapJob).toHaveBeenCalledWith(job, signal);
  });
});

describe('product_context dispatch', () => {
  it('dispatches project-scoped jobs before the error-group-required guard', async () => {
    const job: ClaimedJob = {
      id: 'product-context-1', workerId: 'worker-1', leaseGeneration: '1',
      errorGroupId: null, eventId: null, sourceId: null, projectId: 'proj-1',
      jobType: 'product_context', attempts: 0, guidance: null, triggeredBy: 'auto', sessionId: null,
    };
    const signal = new AbortController().signal;

    await expect(processJobInner(job, signal)).resolves.toBeUndefined();

    expect(runProductContext).toHaveBeenCalledWith(job, signal);
  });
});

describe('issue_inquiry dispatch', () => {
  it('dispatches episode-scoped jobs before the error-group-required guard', async () => {
    const job: ClaimedJob = {
      id: 'inquiry-1', workerId: 'worker-1', leaseGeneration: '1',
      errorGroupId: null, eventId: null, episodeId: 'episode-1', sourceId: null, projectId: 'proj-1',
      jobType: 'issue_inquiry', attempts: 0, guidance: null, triggeredBy: 'auto', sessionId: null,
    };
    const signal = new AbortController().signal;

    await expect(processJobInner(job, signal)).resolves.toBeUndefined();

    expect(runInquiry).toHaveBeenCalledWith(job, signal);
  });
});

describe('digest_write dispatch', () => {
  it('dispatches run-scoped jobs before the error-group-required guard', async () => {
    const job: ClaimedJob = {
      id: 'digest-write-1', workerId: 'worker-1', leaseGeneration: '1',
      errorGroupId: null, eventId: null, sourceId: null, projectId: 'proj-1',
      jobType: 'digest_write', attempts: 0, guidance: null, triggeredBy: 'auto',
      sessionId: null, runId: 'run-1',
    };

    await expect(processJobInner(job, new AbortController().signal)).resolves.toBeUndefined();
    expect(writeDigest).toHaveBeenCalledWith('run-1', 'proj-1');
  });

  it('rejects a job without its digest run', async () => {
    const job: ClaimedJob = {
      id: 'digest-write-2', workerId: 'worker-1', leaseGeneration: '1',
      errorGroupId: null, eventId: null, sourceId: null, projectId: 'proj-1',
      jobType: 'digest_write', attempts: 0, guidance: null, triggeredBy: 'auto',
      sessionId: null, runId: null,
    };

    await expect(processJobInner(job, new AbortController().signal))
      .rejects.toThrow('missing run_id');
  });
});

describe('score_sync dispatch', () => {
  it('dispatches project-scoped score jobs before the error-group-required guard', async () => {
    const job: ClaimedJob = {
      id: 'score-sync-1', workerId: 'worker-1', leaseGeneration: '1',
      errorGroupId: null, eventId: null, sourceId: null, projectId: 'proj-1',
      jobType: 'score_sync', attempts: 0, guidance: null, triggeredBy: null, sessionId: null,
      payload: { fix_job_id: 'fix-1', outcome: 'merged', delivery_id: 'delivery-1' },
    };

    await expect(processJobInner(job, new AbortController().signal)).resolves.toBeUndefined();
    expect(processScoreSyncJob).toHaveBeenCalledWith(job);
  });
});

describe('stack_resolve dispatch', () => {
  it('dispatches event-scoped jobs before the error-group-required guard', async () => {
    const job: ClaimedJob = {
      id: 'resolve-1', workerId: 'worker-1', leaseGeneration: '1',
      errorGroupId: null, eventId: 'event-1', sourceId: null, projectId: 'proj-1',
      jobType: 'stack_resolve', attempts: 0, guidance: null, triggeredBy: null,
      sessionId: null,
    };

    await expect(processJobInner(job, new AbortController().signal)).resolves.toBeUndefined();
    expect(runStackResolve).toHaveBeenCalledWith(job);
  });
});

describe('unknown job type dispatch', () => {
  it('throws instead of falling through to a paid investigation', async () => {
    const job: ClaimedJob = {
      id: 'mystery-1', workerId: 'worker-1', leaseGeneration: '1',
      errorGroupId: 'group-1', eventId: null, sourceId: null, projectId: 'proj-1',
      jobType: 'bogus_future_type' as never, attempts: 0,
      guidance: null, triggeredBy: null, sessionId: null, payload: null,
    };

    await expect(processJobInner(job, new AbortController().signal))
      .rejects.toThrow("Unknown job_type 'bogus_future_type'");
  });
});

describe('session_analysis handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const job: ClaimedJob & { sessionId: string } = {
    id: 'analysis-1', workerId: 'worker-1', leaseGeneration: '1',
    errorGroupId: null, eventId: null, sourceId: null, projectId: 'proj-1',
    jobType: 'session_analysis', attempts: 0, guidance: null, triggeredBy: 'auto', sessionId: 'session-1',
  };

  it('dispatches before the error-group-required guard', async () => {
    vi.mocked(db.getSessionForAnalysis).mockResolvedValue({
      id: 'session-1', project_id: 'proj-1', environment_id: 'env-1', end_user_id: null, status: 'closed', started_at: '2026-08-01T00:00:00Z', chunk_count: 0,
    });
    vi.mocked(db.getScrubbedChunksForSession).mockResolvedValue([]);
    vi.mocked(readChunksBounded).mockResolvedValue({ envelopes: [], envelopeSeqs: [], inflatedBytes: 0, truncated: false, unreadableCount: 0 });
    vi.mocked(analyzeSession).mockReturnValue([]);

    await expect(processJobInner(job, new AbortController().signal)).resolves.toBeUndefined();
    expect(writeFrictionSignals).toHaveBeenCalled();
  });

  it('analyzes scrubbed chunks, persists signals, and marks the session analyzed', async () => {
    const session = {
      id: 'session-1', project_id: 'proj-1', environment_id: 'env-1', end_user_id: null, status: 'closed', started_at: '2026-08-01T00:00:00Z', chunk_count: 0,
    };
    vi.mocked(db.getSessionForAnalysis).mockResolvedValue(session);
    vi.mocked(db.getScrubbedChunksForSession).mockResolvedValue([]);
    vi.mocked(readChunksBounded).mockResolvedValue({ envelopes: [], envelopeSeqs: [], inflatedBytes: 0, truncated: false, unreadableCount: 0 });
    vi.mocked(analyzeSession).mockReturnValue([]);

    await processSessionAnalysisJob(job, new AbortController().signal);

    expect(db.setSessionAnalysisStatus).toHaveBeenNthCalledWith(1, 'session-1', 'proj-1', 'analyzing', undefined, job);
    expect(db.assertJobLease).toHaveBeenCalledWith(job);
    expect(db.upsertSessionAnalysis).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1', coverage: 'no_replay', activityClass: 'unknown', ruleVersion: 2,
    }));
    expect(replaceSessionFacts).toHaveBeenCalledWith('proj-1', 'session-1', expect.objectContaining({
      ruleVersion: 2, failures: [], successes: [],
    }));
    expect(vi.mocked(replaceSessionFacts).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(db.upsertSessionAnalysis).mock.invocationCallOrder[0]!,
    );
    expect(writeFrictionSignals).toHaveBeenCalledWith(session, [], 2);
    expect(db.setSessionAnalysisStatus).toHaveBeenLastCalledWith('session-1', 'proj-1', 'analyzed', 2, job);
    expect(db.updateGroupAndCreateFixJob).not.toHaveBeenCalled();
    expect(vi.mocked(db.assertJobLease).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(db.upsertSessionAnalysis).mock.invocationCallOrder[0]!,
    );
  });

  it('runs friction adjudication after signal persistence when a key is set', async () => {
    const session = {
      id: 'session-1', project_id: 'proj-1', environment_id: 'env-1', end_user_id: null, status: 'closed', started_at: '2026-08-01T00:00:00Z', chunk_count: 0,
    };
    vi.mocked(db.getSessionForAnalysis).mockResolvedValue(session);
    vi.mocked(db.getScrubbedChunksForSession).mockResolvedValue([]);
    vi.mocked(readChunksBounded).mockResolvedValue({ envelopes: [], envelopeSeqs: [], inflatedBytes: 0, truncated: false, unreadableCount: 0 });
    vi.mocked(analyzeSession).mockReturnValue([]);
    const prevKey = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
    try {
      await processSessionAnalysisJob(job, new AbortController().signal);
    } finally {
      if (prevKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = prevKey;
    }
    expect(processFrictionOutcomes).toHaveBeenCalledWith(
      session,
      'analysis-1',
      expect.objectContaining({ modelId: 'real' }),
      expect.objectContaining({ windowMode: 'off' }),
    );
    // Ordering: adjudication runs after persistence, before 'analyzed'.
    expect(vi.mocked(writeFrictionSignals).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(processFrictionOutcomes).mock.invocationCallOrder[0]!,
    );
  });

  it('skips friction adjudication without a key (keyless mode) and still analyzes', async () => {
    const session = {
      id: 'session-1', project_id: 'proj-1', environment_id: 'env-1', end_user_id: null, status: 'closed', started_at: '2026-08-01T00:00:00Z', chunk_count: 0,
    };
    vi.mocked(db.getSessionForAnalysis).mockResolvedValue(session);
    vi.mocked(db.getScrubbedChunksForSession).mockResolvedValue([]);
    vi.mocked(readChunksBounded).mockResolvedValue({ envelopes: [], envelopeSeqs: [], inflatedBytes: 0, truncated: false, unreadableCount: 0 });
    vi.mocked(analyzeSession).mockReturnValue([]);
    const prevKey = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      await processSessionAnalysisJob(job, new AbortController().signal);
    } finally {
      if (prevKey !== undefined) process.env['ANTHROPIC_API_KEY'] = prevKey;
    }
    expect(processFrictionOutcomes).not.toHaveBeenCalled();
    expect(db.setSessionAnalysisStatus).toHaveBeenLastCalledWith('session-1', 'proj-1', 'analyzed', 2, job);
  });

  it('marks analysis_failed and rethrows corrupt chunk failures', async () => {
    vi.mocked(db.getSessionForAnalysis).mockResolvedValue({
      id: 'session-1', project_id: 'proj-1', environment_id: 'env-1', end_user_id: null, status: 'closed', started_at: '2026-08-01T00:00:00Z', chunk_count: 0,
    });
    vi.mocked(db.getScrubbedChunksForSession).mockResolvedValue([]);
    vi.mocked(readChunksBounded).mockRejectedValue(new Error('corrupt gzip'));

    await expect(processSessionAnalysisJob(job, new AbortController().signal)).rejects.toThrow('corrupt gzip');
    expect(db.setSessionAnalysisStatus).toHaveBeenLastCalledWith(
      'session-1', 'proj-1', 'analysis_failed', undefined, job,
    );
  });
});
