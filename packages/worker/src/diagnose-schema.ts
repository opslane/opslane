import type Anthropic from '@anthropic-ai/sdk';
import type { Adjudication, EvidenceStrength, HypothesisKind } from '@opslane/shared';

const KINDS: HypothesisKind[] = ['local_code', 'external_system', 'data_or_input', 'configuration', 'unknown'];
const STRENGTHS: EvidenceStrength[] = ['conclusive', 'suggestive', 'insufficient'];

function isKind(value: unknown): value is HypothesisKind {
  return typeof value === 'string' && (KINDS as string[]).includes(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((i): i is string => typeof i === 'string' && i.trim().length > 0).map((i) => i.trim())
    : [];
}

function clampWords(text: string, max: number): string {
  const words = text.trim().split(/\s+/);
  return words.length <= max ? text.trim() : `${words.slice(0, max).join(' ')}…`;
}

function candidates(value: unknown): Adjudication['candidates_considered'] {
  if (!Array.isArray(value)) return [];
  const out: Adjudication['candidates_considered'] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const statement = typeof record['statement'] === 'string' ? record['statement'].trim() : '';
    if (!statement) continue;
    out.push({ statement, kind: isKind(record['kind']) ? record['kind'] : 'unknown' });
  }
  return out;
}

/**
 * The one terminal tool the investigation may call.
 *
 * Replaces the dossier/adjudicate pair. The split was justified by tracing a
 * single fixture whose family was later found broken, never demonstrated a
 * safety benefit, and produced the refusal surface behind two of six no-answer
 * runs. See docs/design/2026-08-06-harness-decision.md.
 */
export function submitDiagnosisTool(): Anthropic.Tool {
  return {
    name: 'submit_diagnosis',
    description: 'Submit the cause you can best support from evidence you read. Call this exactly once.',
    input_schema: {
      type: 'object',
      properties: {
        best_supported: { type: 'string', description: 'The cause, in one sentence.' },
        evidence_check: { type: 'string', description: 'Which files and evidence you checked.' },
        candidates_considered: {
          type: 'array',
          description: 'Every cause you weighed, including the winner. Routing needs this.',
          items: {
            type: 'object',
            properties: { statement: { type: 'string' }, kind: { type: 'string', enum: KINDS } },
            required: ['statement', 'kind'],
          },
        },
        rejected: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Each candidate you ruled out and what ruled it out. If you conclude the cause is ' +
            'outside this codebase, you must reject every local candidate here by name.',
        },
        evidence_strength: {
          type: 'string',
          enum: STRENGTHS,
          description:
            '"conclusive" only when every premise was verified from evidence you read. ' +
            '"insufficient" means you cannot rank your candidates, not that you are less than certain.',
        },
        cause_kind: { type: 'string', enum: KINDS },
        cause_locations: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Every place the cause lives, MOST IMPORTANT FIRST. The FIRST entry is your claim and ' +
            'is the only one we act on; the rest are advisory. Adding extra entries does not help you.',
        },
        reasoning: { type: 'string' },
        why_chain: { type: 'array', items: { type: 'string' } },
        reproduction_steps: { type: 'array', items: { type: 'string' } },
      },
      required: [
        'best_supported', 'evidence_check', 'candidates_considered', 'rejected',
        'evidence_strength', 'cause_kind', 'cause_locations', 'reasoning',
      ],
    },
  };
}

export function parseLocations(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    // Keep the entry exactly as written FIRST: an external cause like
    // "GET /api/assets/search (remote service)" must survive intact, and
    // extracting a path out of it would mangle the URL. Order is load-bearing:
    // routing acts on out[0].
    out.push(trimmed);
    for (const path of trimmed.match(/[\w.@+-]+(?:\/[\w.@+-]+)+(?::\d+(?:[-:]\d+)?)?/g) ?? []) {
      if (path !== trimmed) out.push(path);
    }
  }
  return [...new Set(out)];
}

export function parseAdjudication(raw: Record<string, unknown>): Adjudication | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const best = typeof raw['best_supported'] === 'string' ? raw['best_supported'].trim() : '';
  if (!best) return null;

  const strength = raw['evidence_strength'];
  return {
    best_supported: best,
    evidence_check: typeof raw['evidence_check'] === 'string' ? raw['evidence_check'].trim() : '',
    candidates_considered: candidates(raw['candidates_considered']),
    rejected: strings(raw['rejected']),
    evidence_strength:
      typeof strength === 'string' && (STRENGTHS as string[]).includes(strength)
        ? (strength as EvidenceStrength)
        : 'insufficient',
    cause_kind: isKind(raw['cause_kind']) ? raw['cause_kind'] : 'unknown',
    cause_locations: parseLocations(raw['cause_locations']),
    reasoning: typeof raw['reasoning'] === 'string' ? raw['reasoning'].trim() : '',
    why_chain: strings(raw['why_chain']),
    reproduction_steps: strings(raw['reproduction_steps']),
  };
}

/**
 * Adapt the fix agent's decline into an adjudication so both paths route
 * through the same derivation.
 *
 * Strength is pinned to `suggestive`, never `conclusive`. The fix agent has no
 * second pass checking its citations, so its own account of why it could not
 * fix something must not be able to authorise an unattended change. That is
 * only a ceiling: the derivation can still drop it to a failure.
 *
 * `candidates_considered` is empty because the decline tool does not collect
 * one. Routing reads that as "no local candidate was raised", which is honest:
 * a decline that never enumerated alternatives has none to reject.
 */
export function adjudicationFromDecline(raw: Record<string, unknown>): Adjudication | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const description = typeof raw['one_line_description'] === 'string' ? raw['one_line_description'].trim() : '';
  if (!description) return null;

  const unknowns = strings(raw['unknowns']);
  const counterfactual =
    typeof raw['change_counterfactual'] === 'string' ? raw['change_counterfactual'].trim() : '';

  return {
    best_supported: clampWords(description, 40),
    why_chain: strings(raw['why_chain']).map((entry) => clampWords(entry, 15)),
    reproduction_steps: strings(raw['reproduction_steps']).map((entry) => clampWords(entry, 15)),
    evidence_check: unknowns.length > 0 ? `Could not establish: ${unknowns.join('; ')}` : 'No gaps reported.',
    candidates_considered: [],
    rejected: [],
    evidence_strength: 'suggestive',
    cause_kind: isKind(raw['cause_kind']) ? raw['cause_kind'] : 'unknown',
    cause_locations: parseLocations(raw['cause_locations'] ?? raw['cause_location']),
    reasoning: clampWords(counterfactual || description, 40),
  };
}
