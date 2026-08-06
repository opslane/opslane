import type Anthropic from '@anthropic-ai/sdk';
import type { Adjudication, Dossier, Hypothesis, HypothesisKind } from '@opslane/shared';

const KINDS: readonly HypothesisKind[] = [
  'local_code',
  'external_system',
  'data_or_input',
  'configuration',
  'unknown',
];

/**
 * The first agent's terminal tool. It carries no outcome and no ranking: the
 * agent reports what the evidence is consistent with, and the adjudicator
 * decides. Asking for one answer is what produced PR #1297, because the first
 * plausible local file wins when only one answer is allowed.
 */
export function submitDossierTool(): Anthropic.Tool {
  return {
    name: 'submit_dossier',
    description:
      'Submit every plausible root cause you found, with the evidence for and against each. ' +
      'Do not choose between them and do not propose a fix.',
    input_schema: {
      type: 'object' as const,
      properties: {
        hypotheses: {
          type: 'array',
          description:
            'Every cause the evidence is consistent with. Include causes outside this ' +
            'codebase. Do not pad the list: a hypothesis you cannot support with observed ' +
            'evidence is worse than no hypothesis.',
          items: {
            type: 'object',
            properties: {
              statement: { type: 'string', description: 'The candidate cause, under 25 words.' },
              kind: { type: 'string', enum: [...KINDS] },
              location: {
                type: 'string',
                description:
                  'path/to/file.ts:42 when this cause is in code you opened, otherwise the ' +
                  'system or input responsible. Leave empty if the evidence does not place it.',
              },
              supports: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Each item quotes evidence you actually observed: a breadcrumb field and its ' +
                  'value, the span between two timestamps, a stack frame, or a file and line you ' +
                  'opened. Never write supporting evidence you did not see.',
              },
              contradicts: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Evidence arguing against this hypothesis. Write "none found" only after looking.',
              },
              would_be_settled_by: {
                type: 'string',
                description: 'The observation that would confirm or kill this candidate.',
              },
            },
            required: ['statement', 'kind', 'supports', 'contradicts', 'would_be_settled_by'],
          },
        },
      },
      required: ['hypotheses'],
    },
  };
}

/**
 * The second agent's terminal tool. It names a winner and rates the evidence,
 * but never names an outcome: routing is derived in code from cause_location,
 * the strength, and the project's fix surface.
 */
export function adjudicateTool(): Anthropic.Tool {
  return {
    name: 'adjudicate',
    description:
      'Decide which hypothesis the evidence actually supports and how strong that evidence is. ' +
      'Do not decide what the pipeline should do about it.',
    input_schema: {
      type: 'object' as const,
      properties: {
        best_supported: {
          type: 'string',
          description: 'The statement of the hypothesis the evidence best supports.',
        },
        why_chain: {
          type: 'array',
          items: { type: 'string' },
          description:
            'The causal chain for that hypothesis, cause to effect, each entry under 15 words.',
        },
        reproduction_steps: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Steps that would reproduce the winning cause, each under 15 words. This is what a ' +
            'human acts on when we do not open a pull request.',
        },
        evidence_check: {
          type: 'string',
          description:
            'Which cited evidence you opened and confirmed, and anything that did not check out. ' +
            'Name every claim you could not verify.',
        },
        rejected: {
          type: 'array',
          items: { type: 'string' },
          description: 'Each other hypothesis with the specific evidence that rules it out.',
        },
        evidence_strength: {
          type: 'string',
          enum: ['conclusive', 'suggestive', 'insufficient'],
          description:
            'conclusive: every premise the conclusion rests on was verified from evidence you ' +
            'read. suggestive: the story fits but a decisive premise is unverified or ' +
            'unverifiable. insufficient: the evidence cannot separate the candidates.',
        },
        cause_kind: {
          type: 'string',
          enum: [...KINDS],
          description:
            'Where the winning cause lives. local_code or configuration mean a defect in this ' +
            'repository. external_system or data_or_input mean the cause is not code we hold. ' +
            'unknown means the evidence did not place it.',
        },
        cause_locations: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Every place the cause lives, most important first. Each entry is a bare ' +
            'path/to/file.ts:42 when cause_kind is local_code or configuration, otherwise the ' +
            'system or input responsible. One entry per location, no prose inside an entry. ' +
            'Empty only when the evidence does not place the cause at all.',
        },
        reasoning: { type: 'string', description: 'Under 40 words.' },
      },
      required: [
        'best_supported',
        'why_chain',
        'reproduction_steps',
        'evidence_check',
        'rejected',
        'evidence_strength',
        'cause_kind',
        'cause_locations',
        'reasoning',
      ],
    },
  };
}

/**
 * Adapt the fix agent's decline into an adjudication so both paths route
 * through the same derivation.
 *
 * Strength is pinned to `suggestive`, never `conclusive`. The fix agent has no
 * adjudicator checking its citations, so its own account of why it could not
 * fix something must not be able to authorise an unattended change. That is
 * only a ceiling: the derivation can still drop it to a failure.
 */
export function adjudicationFromDecline(raw: Record<string, unknown>): Adjudication | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const description = typeof raw['one_line_description'] === 'string' ? raw['one_line_description'].trim() : '';
  const location = typeof raw['cause_location'] === 'string' ? raw['cause_location'].trim() : '';
  if (!description) return null;

  const unknowns = strings(raw['unknowns']);
  const counterfactual =
    typeof raw['change_counterfactual'] === 'string' ? raw['change_counterfactual'].trim() : '';

  return {
    best_supported: clampWords(description, 40),
    why_chain: strings(raw['why_chain']).map((entry) => clampWords(entry, 15)),
    reproduction_steps: strings(raw['reproduction_steps']).map((entry) => clampWords(entry, 15)),
    evidence_check: unknowns.length > 0 ? `Could not establish: ${unknowns.join('; ')}` : 'No gaps reported.',
    rejected: [],
    evidence_strength: 'suggestive',
    cause_kind: isKind(raw['cause_kind']) ? raw['cause_kind'] : 'unknown',
    cause_locations: parseLocations(raw['cause_locations'] ?? raw['cause_location']),
    reasoning: clampWords(counterfactual || description, 40),
  };
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function clampWords(text: string, max: number): string {
  const words = text.trim().split(/\s+/);
  return words.length <= max ? text.trim() : `${words.slice(0, max).join(' ')}…`;
}

function isKind(value: unknown): value is HypothesisKind {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value);
}

/**
 * Returns null when nothing usable was submitted. A null here routes to
 * needs_more_context, never to a conclusion.
 */
export function parseDossier(raw: Record<string, unknown>): Dossier | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const rawHypotheses = raw['hypotheses'];
  if (!Array.isArray(rawHypotheses)) return null;

  const hypotheses: Hypothesis[] = [];
  for (const entry of rawHypotheses) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const statement = typeof record['statement'] === 'string' ? record['statement'].trim() : '';
    const supports = strings(record['supports']);
    // A hypothesis with no observed support is noise, not a candidate. Dropping
    // it here is what stops a quota from being met with invention.
    if (!statement || supports.length === 0) continue;
    hypotheses.push({
      statement: clampWords(statement, 25),
      kind: isKind(record['kind']) ? record['kind'] : 'unknown',
      location: typeof record['location'] === 'string' ? record['location'].trim() : '',
      supports,
      contradicts: strings(record['contradicts']),
      would_be_settled_by:
        typeof record['would_be_settled_by'] === 'string' ? record['would_be_settled_by'].trim() : '',
    });
  }

  return hypotheses.length > 0 ? { hypotheses } : null;
}

const STRENGTHS: readonly string[] = ['conclusive', 'suggestive', 'insufficient'];

/**
 * Returns null when the adjudication is unusable. An unrecognised strength
 * falls back to `insufficient` rather than the permissive end, so a malformed
 * response can never authorise a code change.
 */
export function parseAdjudication(raw: Record<string, unknown>): Adjudication | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;

  const best = typeof raw['best_supported'] === 'string' ? raw['best_supported'].trim() : '';
  if (!best) return null;

  const rawStrength = raw['evidence_strength'];
  const strength = typeof rawStrength === 'string' && STRENGTHS.includes(rawStrength)
    ? (rawStrength as Adjudication['evidence_strength'])
    : 'insufficient';

  return {
    best_supported: clampWords(best, 40),
    why_chain: strings(raw['why_chain']).map((entry) => clampWords(entry, 15)),
    reproduction_steps: strings(raw['reproduction_steps']).map((entry) => clampWords(entry, 15)),
    evidence_check: typeof raw['evidence_check'] === 'string' ? raw['evidence_check'].trim() : '',
    rejected: strings(raw['rejected']),
    evidence_strength: strength,
    // An unrecognised kind falls back to `unknown`, which routes to a failure.
    // Defaulting to a code kind would let a malformed response reach a fix.
    cause_kind: isKind(raw['cause_kind']) ? raw['cause_kind'] : 'unknown',
    cause_locations: parseLocations(raw['cause_locations'] ?? raw['cause_location']),
    reasoning: typeof raw['reasoning'] === 'string' ? clampWords(raw['reasoning'], 40) : '',
  };
}

/**
 * Pull every citation out of whatever the model sent.
 *
 * This field has now discarded three correct answers: prose with no
 * recognisable path, a line range, and a string naming two files where the
 * second was the one the real fix changed. Each time the reply was right and
 * the parser was too narrow, so this reads leniently and lets the routing
 * decide, rather than demanding one exact shape.
 */
export function parseLocations(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    // Keep the entry exactly as written first: an external cause like
    // "GET /issue-context/api/assets/search (remote service)" must survive
    // intact, and extracting a path out of it would mangle the URL.
    out.push(trimmed);
    // Then add any path-shaped tokens it contains, so a citation wrapped in
    // prose still yields something the surface check can resolve. This is what
    // recovers dub #4015, where the reply named two files in one string and the
    // second was the one the real fix changed.
    for (const path of trimmed.match(/[\w.@+-]+(?:\/[\w.@+-]+)+(?::\d+(?:[-:]\d+)?)?/g) ?? []) {
      if (path !== trimmed) out.push(path);
    }
  }
  return [...new Set(out)];
}
