import type Anthropic from '@anthropic-ai/sdk';

export type DigestLabel = 'new' | 'returned';

/** Title cap enforced here, in the Go validator, and stated in the prompt. */
export const DIGEST_TITLE_MAX = 80;
/** Copy/action cap; the renderer truncates at 300 runes, so anything longer
 * would be validated in full and then cut with its meaning changed. */
export const DIGEST_TEXT_MAX = 300;

export interface DigestCard {
  episodeId: string;
  /** Absent only when replaying a payload stored by the pre-v4 writer; the
   * Go validator falls back to the frozen candidate title. */
  title?: string;
  copy: string;
  action: string;
  label: DigestLabel;
  claimedUsers?: number;
  claimedOccurrences?: number;
  accounts?: string[];
  prUrl?: string;
}

export interface DeferredDigestItem {
  episodeId: string;
  reason: string;
}

export interface DigestPayload {
  included: DigestCard[];
  deferred: DeferredDigestItem[];
}

export const DIGEST_PAYLOAD_SCHEMA = {
  type: 'object',
  required: ['included', 'deferred'],
  properties: {
    included: {
      type: 'array',
      items: {
        type: 'object',
        required: ['episodeId', 'title', 'copy', 'action'],
        properties: {
          episodeId: { type: 'string', minLength: 1 },
          title: { type: 'string', minLength: 1 },
          copy: { type: 'string', minLength: 1 },
          action: { type: 'string', minLength: 1 },
          claimedUsers: { type: 'integer' },
          claimedOccurrences: { type: 'integer' },
          accounts: { type: 'array', items: { type: 'string', minLength: 1 } },
          prUrl: { type: 'string', minLength: 1 },
        },
        additionalProperties: false,
      },
    },
    deferred: {
      type: 'array',
      items: {
        type: 'object',
        required: ['episodeId', 'reason'],
        properties: {
          episodeId: { type: 'string', minLength: 1 },
          reason: { type: 'string', minLength: 1 },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const;

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${label} contains unknown field ${unknown}`);
}

/** Parse the strict structural boundary. Grounding against frozen facts is a
 * separate step because those facts are run-specific. */
export function parseDigestPayload(raw: unknown): Omit<DigestPayload, 'included'> & {
  included: Array<Omit<DigestCard, 'label'>>;
} {
  const root = record(raw, 'digest payload');
  exactKeys(root, new Set(['included', 'deferred']), 'digest payload');
  if (!Array.isArray(root['included']) || !Array.isArray(root['deferred'])) {
    throw new Error('digest payload included and deferred must be arrays');
  }
  const included = root['included'].map((value, index) => {
    const card = record(value, `included[${index}]`);
    // label is absent from the model schema, but present when replaying a
    // payload already grounded and stored by the writer.
    exactKeys(card, new Set(['episodeId', 'title', 'copy', 'action', 'claimedUsers', 'claimedOccurrences', 'accounts', 'prUrl', 'label']), `included[${index}]`);
    if (card['claimedUsers'] !== undefined
      && (!Number.isInteger(card['claimedUsers']) || (card['claimedUsers'] as number) < 0)) {
      throw new Error(`included[${index}].claimedUsers must be a non-negative integer`);
    }
    if (card['claimedOccurrences'] !== undefined
      && (!Number.isInteger(card['claimedOccurrences']) || (card['claimedOccurrences'] as number) < 0)) {
      throw new Error(`included[${index}].claimedOccurrences must be a non-negative integer`);
    }
    if (card['accounts'] !== undefined
      && (!Array.isArray(card['accounts']) || card['accounts'].some((account) => typeof account !== 'string' || account.trim() === ''))) {
      throw new Error(`included[${index}].accounts must be non-empty strings`);
    }
    // title is required of the model by the tool schema, but optional here:
    // this parser also replays payloads stored by the pre-v4 writer, and the
    // Go validator has a frozen-title fallback for those.
    const title = card['title'] === undefined ? undefined : text(card['title'], `included[${index}].title`);
    if (title !== undefined && [...title].length > DIGEST_TITLE_MAX) {
      throw new Error(`included[${index}].title must be at most ${DIGEST_TITLE_MAX} characters`);
    }
    const copy = text(card['copy'], `included[${index}].copy`);
    const action = text(card['action'], `included[${index}].action`);
    if (title !== undefined) {
      // Length caps apply to writer-authored (titled) cards only; legacy
      // replayed payloads keep render-time truncation.
      if ([...copy].length > DIGEST_TEXT_MAX) {
        throw new Error(`included[${index}].copy must be at most ${DIGEST_TEXT_MAX} characters`);
      }
      if ([...action].length > DIGEST_TEXT_MAX) {
        throw new Error(`included[${index}].action must be at most ${DIGEST_TEXT_MAX} characters`);
      }
    }
    return {
      episodeId: text(card['episodeId'], `included[${index}].episodeId`),
      ...(title === undefined ? {} : { title }),
      copy,
      action,
      ...(typeof card['claimedUsers'] === 'number' ? { claimedUsers: card['claimedUsers'] } : {}),
      ...(typeof card['claimedOccurrences'] === 'number' ? { claimedOccurrences: card['claimedOccurrences'] } : {}),
      ...(Array.isArray(card['accounts']) ? { accounts: card['accounts'].map((account) => String(account).trim()) } : {}),
      ...(card['prUrl'] !== undefined ? { prUrl: text(card['prUrl'], `included[${index}].prUrl`) } : {}),
    };
  });
  const deferred = root['deferred'].map((value, index) => {
    const item = record(value, `deferred[${index}]`);
    exactKeys(item, new Set(['episodeId', 'reason']), `deferred[${index}]`);
    return {
      episodeId: text(item['episodeId'], `deferred[${index}].episodeId`),
      reason: text(item['reason'], `deferred[${index}].reason`),
    };
  });
  return { included, deferred };
}

export function digestPayloadTool(): Anthropic.Tool {
  return {
    name: 'submit_daily_message',
    description: 'Submit the daily cards and account for every frozen candidate.',
    // No `strict`: constrained decoding corrupts long string values (URLs,
    // UUIDs) on current models, and the API half-applies the flag even without
    // the structured-outputs beta. parseDigestPayload + grounding + the Go
    // validator enforce the contract mechanically instead.
    input_schema: {
      ...DIGEST_PAYLOAD_SCHEMA,
      required: [...DIGEST_PAYLOAD_SCHEMA.required],
      properties: { ...DIGEST_PAYLOAD_SCHEMA.properties },
    },
  };
}
