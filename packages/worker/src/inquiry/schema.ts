import type Anthropic from '@anthropic-ai/sdk';

export const INQUIRY_DECISIONS = [
  'investigate',
  'wait_for_more_evidence',
  'do_not_pursue',
] as const;

export type InquiryDecisionKind = (typeof INQUIRY_DECISIONS)[number];

export interface InquiryDecision {
  decision: InquiryDecisionKind;
  reason: string;
  brief?: string;
  relatedIssues: string[];
}

export const INQUIRY_DECISION_SCHEMA = {
  type: 'object',
  required: ['decision', 'reason'],
  properties: {
    decision: { type: 'string', enum: INQUIRY_DECISIONS },
    reason: { type: 'string', minLength: 1 },
    brief: { type: 'string' },
    related_issues: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
} as const;

const INQUIRY_KEYS = new Set(['decision', 'reason', 'brief', 'related_issues']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDecision(value: unknown): value is InquiryDecisionKind {
  return typeof value === 'string'
    && (INQUIRY_DECISIONS as readonly string[]).includes(value);
}

/** Strict terminal tool for the bounded repository inquiry. */
export function inquiryDecisionTerminalTool(): Anthropic.Tool {
  return {
    name: 'submit_inquiry_decision',
    description: 'Submit the inquiry decision grounded in the supplied evidence and repository.',
    strict: true,
    input_schema: {
      ...INQUIRY_DECISION_SCHEMA,
      required: [...INQUIRY_DECISION_SCHEMA.required],
      properties: { ...INQUIRY_DECISION_SCHEMA.properties },
    },
  };
}

/** Validate the model boundary and ground every relationship in supplied IDs. */
export function parseInquiryDecision(
  raw: unknown,
  suppliedIssueIds: ReadonlySet<string>,
): InquiryDecision {
  if (!isRecord(raw)) throw new Error('inquiry decision must be an object');
  const unknownKey = Object.keys(raw).find((key) => !INQUIRY_KEYS.has(key));
  if (unknownKey) throw new Error(`inquiry decision contains unknown field ${unknownKey}`);
  if (!isDecision(raw['decision'])) {
    throw new Error('inquiry decision must be investigate, wait_for_more_evidence, or do_not_pursue');
  }
  if (typeof raw['reason'] !== 'string' || raw['reason'].trim() === '') {
    throw new Error('inquiry decision reason must be a non-empty string');
  }
  if (raw['brief'] !== undefined
    && (typeof raw['brief'] !== 'string' || raw['brief'].trim() === '')) {
    throw new Error('inquiry decision brief must be a non-empty string when supplied');
  }
  const related = raw['related_issues'] ?? [];
  if (!Array.isArray(related) || related.some((issueId) => typeof issueId !== 'string')) {
    throw new Error('inquiry decision related_issues must be a string array');
  }
  const relatedIssues = [...new Set(related)];
  for (const issueId of relatedIssues) {
    if (!suppliedIssueIds.has(issueId)) {
      throw new Error(`inquiry cited unknown issue ${issueId}`);
    }
  }
  return {
    decision: raw['decision'],
    reason: raw['reason'].trim(),
    ...(typeof raw['brief'] === 'string' ? { brief: raw['brief'].trim() } : {}),
    relatedIssues,
  };
}
