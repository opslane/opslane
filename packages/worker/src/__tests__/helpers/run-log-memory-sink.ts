import { parseInputBundle, type FinishedRow, type InputBundle, type LoggedEvent, type RunUsage, type StartedRow, type TranscriptEvent } from '@opslane/agent-runs';
import { withRunLog, type OpenRunOptions, type RunHandle, type RunLogDeps } from '../../run-logs/handle.js';

export function memoryRunLogDeps(overrides: Partial<RunLogDeps> = {}) {
  const objects = new Map<string, string>();
  const started: StartedRow[] = [];
  const finished: FinishedRow[] = [];
  let next = 0;
  const deps: RunLogDeps = {
    sink: {
      putObject: async (key, body) => { objects.set(key, body); },
      insertStarted: async (row) => { started.push(row); },
      insertFinished: async (row) => { finished.push(row); },
    },
    enabled: true,
    now: () => new Date('2026-09-15T12:00:00Z'),
    newRunId: () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`,
    buildSha: 'test-sha',
    ...overrides,
  };
  const prefix = (index: number) => started[index]!.objectPrefix;
  return {
    deps,
    objects,
    started,
    finished,
    bundle: (index = 0): InputBundle => JSON.parse(objects.get(`${prefix(index)}input.json`)!) as InputBundle,
    transcript: (index = 0): TranscriptEvent[] => objects.get(`${prefix(index)}transcript.jsonl`)!
      .trim().split('\n').map((line) => JSON.parse(line) as TranscriptEvent),
  };
}

/** A RunHandle that keeps everything in memory, for gateway unit tests. */
export function capturedRun() {
  const state = {
    events: [] as LoggedEvent[],
    requests: [] as unknown[],
    counted: 0,
    usage: null as Record<string, RunUsage> | null,
    turns: null as number | null,
  };
  const run: RunHandle = {
    runId: 'test-run',
    countRequest: () => { state.counted++; },
    noteRequest: (request) => { state.counted++; state.requests.push(request); },
    event: (event) => { state.events.push(event); },
    replaceUsage: (totals) => { state.usage = totals; },
    setTurns: (turns) => { state.turns = turns; },
  };
  return Object.assign(state, { run });
}

const REBUILD_CONTEXT = {
  jobId: '11111111-1111-4111-8111-111111111111', jobType: 'test', projectId: 'p1', attempts: 0,
  leaseGeneration: '1', errorGroupId: null, ticketId: null, episodeId: null, batchId: null, sessionId: null,
};

/** Persist a run through the real withRunLog and read its validated bundle back. */
export async function recordedBundle(options: OpenRunOptions): Promise<InputBundle> {
  const memory = memoryRunLogDeps();
  await withRunLog({ ...options, context: options.context ?? REBUILD_CONTEXT }, async () => undefined, () => 'completed', memory.deps);
  return parseInputBundle(JSON.parse(memory.objects.get(`${memory.started[0]!.objectPrefix}input.json`)!));
}
