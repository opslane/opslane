import type Anthropic from '@anthropic-ai/sdk';
import { WINDOW } from './quote-at.js';
import type {
  Adjudication,
  CauseLocation,
  EvidenceCitation,
  EvidenceStrength,
  GroundedQuote,
  HypothesisKind,
} from '@opslane/shared';

const KINDS: HypothesisKind[] = ['local_code', 'external_system', 'data_or_input', 'configuration', 'unknown'];
const STRENGTHS: EvidenceStrength[] = ['conclusive', 'suggestive', 'insufficient'];
export const QUOTE_MAX_CHARS = 300;
/**
 * A one-or-two-character "quote" ("}", ";") occurs in virtually any source
 * window, which would let an evidence-free citation count as grounded. The
 * floor forces the excerpt to actually identify code.
 */
export const QUOTE_MIN_CHARS = 8;
export const CANDIDATE_ID = /^c[1-9]\d*$/;

function isKind(value: unknown): value is HypothesisKind {
  return typeof value === 'string' && (KINDS as string[]).includes(value);
}

/** Narrow an unknown field to the non-empty, trimmed strings it contains. */
export function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((i): i is string => typeof i === 'string' && i.trim().length > 0).map((i) => i.trim())
    : [];
}

function clampWords(text: string, max: number): string {
  const words = text.trim().split(/\s+/);
  return words.length <= max ? text.trim() : `${words.slice(0, max).join(' ')}…`;
}

function groundedQuote(value: unknown): GroundedQuote | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const path = typeof record['path'] === 'string' ? record['path'].trim() : '';
  const line = typeof record['line'] === 'number' && record['line'] > 0 ? Math.trunc(record['line']) : 0;
  const quote = typeof record['quote'] === 'string' ? record['quote'].trim() : '';
  if (!path || !line || quote.length < QUOTE_MIN_CHARS || quote.length > QUOTE_MAX_CHARS) return undefined;
  return { path, line, quote };
}

function candidateId(value: unknown): string | undefined {
  return typeof value === 'string' && CANDIDATE_ID.test(value) ? value : undefined;
}

/** Parser-side bound for candidate lists. The API-facing schema cannot carry
 * `maxItems` (the Anthropic API 400s on array bounds in custom tool schemas),
 * so the cap the schema used to enforce lives here instead. */
export const MAX_CANDIDATES = 16;

function candidates(value: unknown): Adjudication['candidates_considered'] {
  if (!Array.isArray(value)) return [];
  const out: Adjudication['candidates_considered'] = [];
  for (const entry of value) {
    if (out.length >= MAX_CANDIDATES) break;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const statement = typeof record['statement'] === 'string' ? record['statement'].trim() : '';
    if (!statement) continue;
    const id = candidateId(record['id']);
    const citation = groundedQuote(record['citation']);
    out.push({
      statement,
      kind: isKind(record['kind']) ? record['kind'] : 'unknown',
      ...(id ? { id } : {}),
      ...(citation ? { citation } : {}),
    });
  }
  return out;
}

type RejectedCandidate = NonNullable<Adjudication['rejected_candidates']>[number];

/**
 * The parser's marker for a rejection whose JSON was malformed. A factory, not
 * a shared constant: entries are pushed into caller-visible arrays, and one
 * aliased object would make every malformed entry (and the module constant)
 * mutate together.
 */
function malformedRejection(): RejectedCandidate {
  return { id: '', evidence: '', citation: { path: '', line: 1, quote: '' } };
}

/**
 * The validator-side half of the malformed-rejection convention. Kept next to
 * the factory so producer and detector cannot drift apart across files.
 */
export function isMalformedRejection(rejection: RejectedCandidate): boolean {
  return !rejection.id || !rejection.citation.path || !rejection.citation.quote;
}

/**
 * The one JSON-schema shape for a GroundedQuote citation. A factory so the two
 * call sites (nullable candidate variant, required rejection variant) cannot
 * drift; `seal()` mutates schemas in place, so sharing one object would let a
 * spread on one variant leak into the other.
 */
function citationSchema(): Record<string, unknown> {
  return {
    type: 'object',
    description: `Verbatim quote from within ${WINDOW} lines of \`line\` in \`path\`; checked mechanically.`,
    properties: {
      path: { type: 'string' },
      line: { type: 'integer' },
      quote: { type: 'string', minLength: QUOTE_MIN_CHARS, maxLength: QUOTE_MAX_CHARS },
    },
    required: ['path', 'line', 'quote'],
  };
}

function rejectedCandidates(raw: Record<string, unknown>): Adjudication['rejected_candidates'] {
  // An absent key marks a legacy row. Any present malformed shape stays
  // visible to validation instead of becoming a valid empty rejection list.
  if (!('rejected_candidates' in raw)) return undefined;
  const value = raw['rejected_candidates'];
  if (!Array.isArray(value)) return [malformedRejection()];

  const out: NonNullable<Adjudication['rejected_candidates']> = [];
  for (const entry of value) {
    if (out.length >= MAX_CANDIDATES) break;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      out.push(malformedRejection());
      continue;
    }
    const record = entry as Record<string, unknown>;
    out.push({
      id: candidateId(record['id']) ?? '',
      evidence: typeof record['evidence'] === 'string' ? record['evidence'].trim() : '',
      citation: groundedQuote(record['citation']) ?? { path: '', line: 1, quote: '' },
    });
  }
  return out;
}

/**
 * Recursively require `additionalProperties: false`, which the API demands of
 * every object in a strict schema (a 400 otherwise: "For 'object' type,
 * 'additionalProperties' must be explicitly set to false").
 */
export function seal<T>(node: T): T {
  if (!node || typeof node !== 'object') return node;
  const schema = node as unknown as Record<string, unknown>;
  const type = schema['type'];
  if (type === 'object' || (Array.isArray(type) && type.includes('object'))) {
    schema['additionalProperties'] = false;
    Object.values((schema['properties'] ?? {}) as Record<string, unknown>).forEach(seal);
  }
  if (type === 'array') seal(schema['items']);
  return node;
}

/** Evidence citation sub-schema, shared verbatim by submit_diagnosis and the
 * friction lane's classify_friction so the prompt-load-bearing descriptions
 * cannot drift between the two pipelines. */
export const EVIDENCE_ARRAY_SCHEMA = {
  type: 'array',
  // No minItems: the Anthropic API rejects array bounds in custom tool schemas
  // (400 invalid_request_error). The at-least-one rule is enforced after the
  // call: a verdict without citations is discarded as incomplete.
  description: 'Citations that will be mechanically checked against the checkout. At least one is required; a verdict without citations is rejected as incomplete. Cite only files you actually read.',
  items: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Repository-relative path, undecorated.' },
      detail: { type: 'string', description: 'What was found at this path.' },
      symptomLink: { type: 'string', description: 'How that finding links to the customer-visible symptom.' },
    },
    required: ['path', 'detail', 'symptomLink'],
  },
};

/**
 * The one terminal tool the investigation may call.
 *
 * Replaces the dossier/adjudicate pair. The split was justified by tracing a
 * single fixture whose family was later found broken, never demonstrated a
 * safety benefit, and produced the refusal surface behind two of six no-answer
 * runs. See docs/design/incident-conclusions.md.
 */
export function submitDiagnosisTool(): Anthropic.Tool {
  return {
    name: 'submit_diagnosis',
    description: 'Submit the cause you can best support from evidence you read. Call this exactly once.',
    // The API validates the arguments against this schema and will not deliver a
    // call that violates it. That is what makes `cause_locations` an array of
    // objects rather than something we have to defend against: the model cannot
    // hand back a JSON-encoded string, which it did on formbricks#8288 — the
    // whole blob became one path, the citation did not resolve, and a diagnosis
    // naming the correct file exactly was discarded. Enforcing the shape at the
    // boundary beats recovering it afterwards.
    strict: true,
    input_schema: seal({
      type: 'object',
      properties: {
        best_supported: { type: 'string', description: 'The cause, in one sentence.' },
        evidence_check: { type: 'string', description: 'Which files and evidence you checked.' },
        candidates_considered: {
          type: 'array',
          description:
            'Every cause you weighed, including the winner. List at most 16; entries past the sixteenth are dropped. ' +
            'Give each candidate an id ("c1", "c2", …). ' +
            'For local_code and configuration candidates, citation is MANDATORY and must be real: ' +
            `{path, line, quote} with a verbatim quote from within ${WINDOW} lines of \`line\` in that file. Pass ` +
            'citation: null for other kinds. A candidate whose citation does not check out against the ' +
            'repository cannot block an external conclusion; it is recorded as ungrounded.',
          items: {
            type: 'object',
            properties: {
              statement: { type: 'string' },
              kind: { type: 'string', enum: KINDS },
              id: { type: 'string' },
              citation: { ...citationSchema(), type: ['object', 'null'] },
            },
            required: ['statement', 'kind', 'id', 'citation'],
          },
        },
        rejected: {
          type: 'array',
          items: { type: 'string' },
          description: 'Legacy prose summary of candidates ruled out. Structural routing uses rejected_candidates.',
        },
        rejected_candidates: {
          type: 'array',
          description:
            'Reject candidates BY ID, at most 16; entries past the sixteenth are dropped. ' +
            'Each rejection needs its own citation {path, line, quote} anchoring ' +
            'the evidence in a file you read — prose alone rejects nothing. Pass [] when you reject nothing.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              evidence: { type: 'string' },
              citation: citationSchema(),
            },
            required: ['id', 'evidence', 'citation'],
          },
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
          description:
            'Every place the cause lives, MOST IMPORTANT FIRST. The FIRST entry is your claim and ' +
            'is the only one we act on; the rest are advisory. Adding extra entries does not help you.',
          items: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description:
                  'Repository-relative path ONLY, exactly as it appears in the repository, e.g. ' +
                  '"packages/ui/src/nav/nav-mobile.tsx". No line numbers, no ranges, no parentheses, ' +
                  'no explanation — put those in `line` and `note`.',
              },
              line: { type: ['integer', 'null'], description: '1-based line number, or null.' },
              note: { type: ['string', 'null'], description: 'Why this location matters, or null. Say it here, not in `path`.' },
            },
            required: ['path', 'line', 'note'],
          },
        },
        reasoning: { type: 'string' },
        why_chain: { type: 'array', items: { type: 'string' } },
        reproduction_steps: { type: 'array', items: { type: 'string' } },
        evidence: EVIDENCE_ARRAY_SCHEMA,
        agent_task_brief: {
          type: 'string',
          description: 'Self-contained markdown brief a coding agent can execute: symptom, files, cause, change, verification. Empty string if you cannot support one.',
        },
      },
      required: [
        'best_supported', 'evidence_check', 'candidates_considered', 'rejected', 'rejected_candidates',
        'evidence_strength', 'cause_kind', 'cause_locations', 'reasoning',
        'why_chain', 'reproduction_steps', 'evidence', 'agent_task_brief',
      ],
    }),
  };
}

/**
 * A decorated citation the schema no longer asks for, e.g.
 * `src/nav.tsx:106-111 (missing overflow-y-auto)`. Splits into path, line and
 * note rather than discarding the whole entry.
 *
 * This is a fallback for callers that still submit a bare string — the decline
 * path in the fix agent, and any model that ignores the object schema. Four
 * correct answers were thrown away when this shape was the only shape and a
 * whole-string regex had to match it.
 */
function locationFromString(raw: string): CauseLocation | null {
  const trimmed = raw.trim().replace(/^[`'"]+|[`'"]+$/g, '');
  if (!trimmed) return null;

  // Peel a trailing parenthetical or " - explanation" off as the note.
  const noted = /^(.*?)\s*(?:\((.+)\)|[-–—]\s+(.+))\s*$/.exec(trimmed);
  const head = (noted?.[1] ?? trimmed).trim();
  const note = noted?.[2] ?? noted?.[3];

  // Then a trailing :line, :line-range or :line:col.
  const located = /^(.*?):(\d+)(?:[-:]\d+)?$/.exec(head);
  const path = (located?.[1] ?? head).trim();
  if (!path) return null;

  const line = located?.[2] ? Number(located[2]) : undefined;
  return {
    path,
    ...(line !== undefined && line > 0 ? { line } : {}),
    ...(note ? { note: note.trim() } : {}),
  };
}

/**
 * Parse `cause_locations` into structured locations, preserving order.
 *
 * Order is load-bearing: routing acts on the first entry, so nothing here may
 * reorder the list or promote a later entry ahead of an earlier one.
 */
export function parseLocations(value: unknown): CauseLocation[] {
  const raw = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const out: CauseLocation[] = [];

  for (const entry of raw) {
    if (typeof entry === 'string') {
      const parsed = locationFromString(entry);
      if (parsed) out.push(parsed);
      continue;
    }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;

    const record = entry as Record<string, unknown>;
    // A model that fills `path` with a decorated string still gets split, so a
    // schema it half-followed does not cost us the answer.
    const parsed = typeof record['path'] === 'string' ? locationFromString(record['path']) : null;
    if (!parsed) continue;

    const line = typeof record['line'] === 'number' && record['line'] > 0 ? Math.trunc(record['line']) : parsed.line;
    const note = typeof record['note'] === 'string' && record['note'].trim() ? record['note'].trim() : parsed.note;
    out.push({ path: parsed.path, ...(line !== undefined ? { line } : {}), ...(note ? { note } : {}) });
  }

  // Dedup by path+line, keeping the first occurrence so order survives.
  const seen = new Set<string>();
  return out.filter((location) => {
    const key = `${location.path}:${location.line ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Shared with the friction lane (classify_friction) — keep the narrowing in
 * one place so the two pipelines cannot drift. Returns undefined when the
 * value is not an array; malformed entries are dropped and the validator
 * judges sufficiency of what remains. */
export function parseEvidence(value: unknown): EvidenceCitation[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const citations: EvidenceCitation[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const path = typeof record['path'] === 'string' ? record['path'].trim() : '';
    const detail = typeof record['detail'] === 'string' ? record['detail'].trim() : '';
    const symptomLink = typeof record['symptomLink'] === 'string' ? record['symptomLink'].trim() : '';
    if (path && detail && symptomLink) citations.push({ path, detail, symptomLink });
  }
  return citations;
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
    rejected_candidates: rejectedCandidates(raw),
    evidence_strength:
      typeof strength === 'string' && (STRENGTHS as string[]).includes(strength)
        ? (strength as EvidenceStrength)
        : 'insufficient',
    cause_kind: isKind(raw['cause_kind']) ? raw['cause_kind'] : 'unknown',
    cause_locations: parseLocations(raw['cause_locations']),
    reasoning: typeof raw['reasoning'] === 'string' ? raw['reasoning'].trim() : '',
    why_chain: strings(raw['why_chain']),
    reproduction_steps: strings(raw['reproduction_steps']),
    evidence: parseEvidence(raw['evidence']),
    agent_task_brief: typeof raw['agent_task_brief'] === 'string' ? raw['agent_task_brief'] : undefined,
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
