import type { PhaseMeter } from '../metered.js';
import { extractJsonObject, type NarrativeClient } from '../narrative/client.js';
import { fenced } from '../prompt-fence.js';
import type { TicketRow } from './tickets-db.js';

type MatchClient = Pick<NarrativeClient, 'complete' | 'modelName'>;
type MatchMeter = Pick<PhaseMeter, 'add'>;

/** One atomic narrative observation presented to cheap matching. */
export interface MatchObservation {
  id: string;
  what: string;
}

/** Inputs already scoped by the caller to one project and its candidate tickets. */
export interface MatchObservationsInput {
  projectName: string;
  screens: string[];
  timelineText: string;
  observations: MatchObservation[];
  candidates: TicketRow[];
}

export interface MatchedObservationDecision {
  kind: 'matched';
  observationId: string;
  observationWhat: string;
  ticketId: string;
}

export interface DraftObservationDecision {
  kind: 'draft';
  observationId: string;
  observationWhat: string;
  draft: {
    name: string;
    control: string;
    steps: string;
  };
}

/** A cheap-pass choice. Drafts require strong review and are not tickets. */
export type ObservationMatchDecision = MatchedObservationDecision | DraftObservationDecision;

/** Invalid model output is all-or-nothing so the caller can retry the pass. */
export type MatchObservationsResult =
  | { decisions: ObservationMatchDecision[] }
  | { invalid: string };

const MATCH_SYSTEM_PROMPT = `Match every supplied observation to an immutable known ticket or produce a draft for strong review.

For each observation, first enumerate every candidate ticket and compare its exact control, action, and symptom. Then choose a ticket only when it describes the same concrete control, action, and symptom. A generic category, shared route, or broadly similar screen is not enough. If no candidate is the same problem, produce a draft. Never create or modify a ticket. Never discard an observation or return not_a_problem. Preserve every supplied observation ID and ticket ID exactly.

Return JSON only with exactly this shape:
{"decisions":[
  {"kind":"matched","observation_id":"...","ticket_id":"..."},
  {"kind":"draft","observation_id":"...","draft":{"name":"...","control":"...","steps":"..."}}
]}
Every observation must appear exactly once. Do not add keys.`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(object: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(object).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === [...expected].sort()[index]);
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function invalid(reason: string): MatchObservationsResult {
  return { invalid: reason };
}

function validateDecisions(
  value: unknown,
  observations: MatchObservation[],
  candidateIds: Set<string>,
): MatchObservationsResult {
  if (!isRecord(value) || !hasExactKeys(value, ['decisions']) || !Array.isArray(value['decisions'])) {
    return invalid('response must contain only a decisions array');
  }

  const observationById = new Map(observations.map((observation) => [observation.id, observation]));
  if (observationById.size !== observations.length) return invalid('input observation IDs must be unique');
  const seen = new Set<string>();
  const decisions: ObservationMatchDecision[] = [];

  for (const [index, rawDecision] of value['decisions'].entries()) {
    if (!isRecord(rawDecision) || !nonBlank(rawDecision['observation_id'])) {
      return invalid(`decision ${index} is malformed`);
    }
    const observationId = rawDecision['observation_id'];
    const observation = observationById.get(observationId);
    if (!observation) return invalid(`decision ${index} has an unknown observation ID`);
    if (seen.has(observationId)) return invalid(`observation ${observationId} appears more than once`);
    seen.add(observationId);

    if (rawDecision['kind'] === 'matched') {
      if (!hasExactKeys(rawDecision, ['kind', 'observation_id', 'ticket_id'])
        || !nonBlank(rawDecision['ticket_id']) || !candidateIds.has(rawDecision['ticket_id'])) {
        return invalid(`matched decision ${index} is malformed or outside the candidate shortlist`);
      }
      decisions.push({
        kind: 'matched',
        observationId,
        observationWhat: observation.what,
        ticketId: rawDecision['ticket_id'],
      });
      continue;
    }

    if (rawDecision['kind'] === 'draft') {
      const draft = rawDecision['draft'];
      if (!hasExactKeys(rawDecision, ['kind', 'observation_id', 'draft']) || !isRecord(draft)
        || !hasExactKeys(draft, ['name', 'control', 'steps'])
        || !nonBlank(draft['name']) || !nonBlank(draft['control']) || !nonBlank(draft['steps'])) {
        return invalid(`draft decision ${index} is malformed`);
      }
      decisions.push({
        kind: 'draft',
        observationId,
        observationWhat: observation.what,
        draft: { name: draft['name'], control: draft['control'], steps: draft['steps'] },
      });
      continue;
    }

    return invalid(`decision ${index} has an unexpected kind`);
  }

  if (seen.size !== observations.length) return invalid('every observation must appear exactly once');
  return { decisions };
}

/**
 * Run the cheap, non-writing observation pass. The caller owns meter flushing
 * and any retry or persistence policy.
 */
export async function matchObservations(
  client: MatchClient,
  input: MatchObservationsInput,
  meter: MatchMeter,
): Promise<MatchObservationsResult> {
  if (input.observations.length === 0) return { decisions: [] };

  const promptData = {
    projectName: input.projectName,
    screens: input.screens,
    timeline: input.timelineText,
    observations: input.observations.map(({ id, what }) => ({ id, what })),
    candidates: input.candidates.map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      control: candidate.control,
      whatHappened: candidate.what_happened,
      steps: candidate.steps,
      screensConfirmed: candidate.screens_confirmed,
      screensProposed: candidate.screens_proposed,
    })),
  };
  const response = await client.complete({
    system: MATCH_SYSTEM_PROMPT,
    user: `<untrusted_data>\n${fenced(JSON.stringify(promptData), 64_000)}\n</untrusted_data>`,
  });
  meter.add(client.modelName, {
    input: response.inputTokens,
    output: response.outputTokens,
    cacheRead: response.cacheReadTokens,
    cacheWrite: response.cacheWriteTokens,
  });

  if (response.stopReason === 'max_tokens') return invalid('model response was truncated');
  const extracted = extractJsonObject(response.text);
  if (!extracted) return invalid('no complete JSON object in response');
  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted);
  } catch {
    return invalid('invalid JSON response');
  }
  return validateDecisions(parsed, input.observations, new Set(input.candidates.map(({ id }) => id)));
}
