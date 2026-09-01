import type {
  FrameVerification,
  NarrativeObservation,
  ObservationGrade,
  SessionChunkEnvelope,
  SessionNarrative,
} from '@opslane/shared';
import * as db from '../db.js';
import type { ClaimedJob } from '../db.js';
import { logger } from '../logger.js';
import type { NarrativeClient } from './client.js';
import { extractJsonObject } from './client.js';
import { buildSignalRows, type CompactTimeline } from './emit.js';
import type { CapturedFrame } from './frames/capture.js';

export const VERIFY_PROMPT_VERSION = 1;
const GRADES: ReadonlySet<string> = new Set(['confirmed', 'corrected', 'refuted', 'inconclusive']);

export interface VerifyJobDeps {
  client: NarrativeClient;
  loadChunks(sessionId: string, projectId: string): Promise<SessionChunkEnvelope[]>;
  capture(
    envelopes: SessionChunkEnvelope[],
    offsetsMs: number[],
  ): Promise<{ frames: CapturedFrame[]; assetsMissing: boolean }>;
  uploadFrame(objectKey: string, png: Buffer): Promise<void>;
  dailyCap: number;
  supported?: boolean;
}

type VerificationValidation =
  | { ok: true; grades: FrameVerification['grades'] }
  | { ok: false; reason: string };

function isNarrative(value: unknown): value is SessionNarrative {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  return typeof object['userGoal'] === 'string'
    && typeof object['narrative'] === 'string'
    && typeof object['notable'] === 'boolean'
    && Array.isArray(object['observations']);
}

function isTimeline(value: unknown): value is CompactTimeline {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  return typeof object['startTs'] === 'number' && Array.isArray(object['lines']);
}

export function validateVerification(
  rawText: string,
  narrative: SessionNarrative,
): VerificationValidation {
  const json = extractJsonObject(rawText);
  if (!json) return { ok: false, reason: 'no JSON object in response' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'invalid JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'not an object' };
  }
  const rawGrades = (parsed as Record<string, unknown>)['grades'];
  if (!Array.isArray(rawGrades)) return { ok: false, reason: 'grades must be an array' };
  const expected = new Set(narrative.observations.map((observation) => observation.id));
  const seen = new Set<string>();
  const grades: FrameVerification['grades'] = [];
  for (const rawGrade of rawGrades) {
    if (!rawGrade || typeof rawGrade !== 'object' || Array.isArray(rawGrade)) {
      return { ok: false, reason: 'grade must be an object' };
    }
    const gradeObject = rawGrade as Record<string, unknown>;
    const observationId = gradeObject['observationId'];
    const grade = gradeObject['grade'];
    const reason = gradeObject['reason'];
    if (typeof observationId !== 'string' || !expected.has(observationId) || seen.has(observationId)) {
      return { ok: false, reason: 'unknown or duplicate observation id' };
    }
    if (typeof grade !== 'string' || !GRADES.has(grade)) {
      return { ok: false, reason: 'unknown grade' };
    }
    if (typeof reason !== 'string' || reason.length === 0 || reason.length > 400) {
      return { ok: false, reason: 'invalid reason' };
    }
    const replacement = gradeObject['replacementWhat'];
    if (grade === 'corrected' && (typeof replacement !== 'string' || replacement.length === 0 || replacement.length > 400)) {
      return { ok: false, reason: 'corrected grade requires replacementWhat' };
    }
    seen.add(observationId);
    grades.push({
      observationId,
      grade: grade as ObservationGrade,
      reason,
      ...(grade === 'corrected' ? { replacementWhat: replacement as string } : {}),
    });
  }
  if (seen.size !== expected.size) return { ok: false, reason: 'every observation must be graded' };
  return { ok: true, grades };
}

export function selectMoments(
  narrative: SessionNarrative,
  timeline: CompactTimeline,
): number[] {
  const rank = { low: 0, medium: 1, high: 2 } as const;
  const ordered = narrative.observations
    .map((observation, index) => ({ observation, index }))
    .sort((left, right) => rank[right.observation.severity] - rank[left.observation.severity]
      || left.index - right.index);
  const moments: number[] = [];
  for (const { observation } of ordered) {
    const lineIndex = Number(observation.evidenceLines[0]?.slice(1)) - 1;
    const absoluteMs = timeline.lines[lineIndex]?.a;
    if (absoluteMs === null || absoluteMs === undefined) continue;
    const offset = Math.max(0, absoluteMs - timeline.startTs);
    if (!moments.includes(offset)) moments.push(offset);
    if (moments.length === 3) break;
  }
  return moments;
}

export function buildVerifyPrompt(): string {
  return `You previously analyzed a user session from a TEXT timeline. You now also have SCREENSHOTS reconstructed from the replay at the cited moments, as before/after pairs (the "b" frame is 2 seconds after "a"). Screenshots may be missing styles (reconstruction limits) — judge content, not polish.

Grade EVERY observation:
- confirmed: the frames visually support the claim
- corrected: the frames show the claim is partly wrong — provide replacementWhat with the accurate one-sentence version
- refuted: the frames show the claim is wrong
- inconclusive: the frames cannot decide (ALWAYS use this for temporal claims a still pair cannot prove)

Output JSON only: {"grades":[{"observationId":"...","grade":"confirmed|corrected|refuted|inconclusive","reason":"one sentence","replacementWhat":"only for corrected"}]}`;
}

function gradedObservations(
  narrative: SessionNarrative,
  grades: FrameVerification['grades'],
): NarrativeObservation[] {
  const byId = new Map(grades.map((grade) => [grade.observationId, grade]));
  return narrative.observations.flatMap((observation) => {
    const grade = byId.get(observation.id);
    if (!grade || grade.grade === 'refuted') return [];
    return [{
      ...observation,
      what: grade.grade === 'corrected' ? grade.replacementWhat! : observation.what,
    }];
  });
}

export async function processFrameVerification(
  job: ClaimedJob & { sessionId: string },
  deps: VerifyJobDeps,
  signal: AbortSignal,
): Promise<void> {
  const claimed = await db.claimVerifyingNarrative(job.sessionId, job.projectId);
  if (!claimed) return;
  if (!isNarrative(claimed.narrative) || !isTimeline(claimed.timeline)) {
    throw new Error('claimed narrative row has invalid stored JSON');
  }
  const narrative = claimed.narrative;
  const timeline = claimed.timeline;
  const unverifiedRows = buildSignalRows(timeline, narrative.observations);
  const finalizeFallback = async (
    state: 'failed' | 'unsupported' | 'skipped_budget',
    reason?: string,
  ): Promise<void> => {
    await db.finalizeVerification(job, {
      sessionId: job.sessionId,
      projectId: job.projectId,
      state,
      claimedPromptVersion: claimed.promptVersion,
      ...(reason === undefined ? {} : { reason }),
      signalRows: unverifiedRows,
    });
  };

  if (deps.supported === false) {
    await finalizeFallback('unsupported');
    return;
  }
  const budgetReserved = await db.reserveNarrativeBudget({
    sessionId: job.sessionId,
    projectId: job.projectId,
    stage: 'verify',
    cap: deps.dailyCap,
  });
  if (!budgetReserved || await db.narrativeMonthlySpendExceeded(job.projectId)) {
    await finalizeFallback('skipped_budget');
    return;
  }
  if (signal.aborted) throw new Error('frame verification aborted');

  const envelopes = await deps.loadChunks(job.sessionId, job.projectId);
  let captureResult: Awaited<ReturnType<VerifyJobDeps['capture']>>;
  try {
    captureResult = await deps.capture(envelopes, selectMoments(narrative, timeline));
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn('Frame capture failed; emitting unverified observations', {
      job_id: job.id,
      session_id: job.sessionId,
      error: reason,
    });
    await finalizeFallback('failed', `frame capture failed: ${reason}`);
    return;
  }

  const manifest: FrameVerification['frames'] = [];
  for (const frame of captureResult.frames) {
    const objectKey = `sessions/${job.projectId}/${job.sessionId}/frames/v${VERIFY_PROMPT_VERSION}/t${frame.offsetMs}_${frame.pair}.png`;
    await deps.uploadFrame(objectKey, frame.png);
    manifest.push({
      offsetMs: frame.offsetMs,
      pair: frame.pair,
      objectKey,
      caption: `t+${(frame.offsetMs / 1_000).toFixed(1)}s (${frame.pair})`,
    });
  }
  const response = await deps.client.complete({
    system: buildVerifyPrompt(),
    user: `OBSERVATIONS_START\n${JSON.stringify(narrative.observations)}\nOBSERVATIONS_END\nTIMELINE_START\n${timeline.lines.map((line, index) => `L${index + 1} ${line.t}`).join('\n')}\nTIMELINE_END`,
    images: captureResult.frames.map((frame) => ({ mediaType: 'image/png', base64: frame.png.toString('base64') })),
  });
  const validated = response.stopReason === 'max_tokens'
    ? { ok: false as const, reason: 'truncated (max_tokens)' }
    : validateVerification(response.text, narrative);
  if (!validated.ok) {
    logger.warn('Frame verification output invalid; emitting unverified observations', {
      job_id: job.id,
      session_id: job.sessionId,
      reason: validated.reason,
    });
    await finalizeFallback('failed', `vision output rejected: ${validated.reason}`);
    return;
  }
  const verification: FrameVerification = { grades: validated.grades, frames: manifest };
  await db.finalizeVerification(job, {
    sessionId: job.sessionId,
    projectId: job.projectId,
    state: 'ok',
    claimedPromptVersion: claimed.promptVersion,
    verification,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    signalRows: buildSignalRows(timeline, gradedObservations(narrative, validated.grades)),
  });
}
