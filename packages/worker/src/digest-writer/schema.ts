import type Anthropic from '@anthropic-ai/sdk';

export type DigestLabel = 'new' | 'returned';

/** Title cap enforced here, in the Go validator, and stated in the prompt. */
export const DIGEST_TITLE_MAX = 80;
/** Copy/action cap; the renderer truncates at 300 runes, so anything longer
 * would be validated in full and then cut with its meaning changed. */
export const DIGEST_TEXT_MAX = 300;

export interface DigestCard {
  /** Incident identity for current snapshots. During the rolling transition,
   * stored payloads may carry only episodeId. Grounding fills every identity
   * available on the frozen candidate before persistence. */
  errorGroupId?: string;
  episodeId?: string;
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
  errorGroupId?: string;
  episodeId?: string;
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
        required: ['title', 'copy', 'action'],
        anyOf: [{ required: ['errorGroupId'] }, { required: ['episodeId'] }],
        properties: {
          errorGroupId: { type: 'string', minLength: 1 },
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
        required: ['reason'],
        anyOf: [{ required: ['errorGroupId'] }, { required: ['episodeId'] }],
        properties: {
          errorGroupId: { type: 'string', minLength: 1 },
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

/** The deferral reason a structurally unusable card carries, so the incident
 * still reaches the digest as its mechanical receipt instead of vanishing. */
export const REJECTED_CARD_REASON = 'the authored card was unusable';

export interface DigestPayloadWarning {
  message: string;
  fields: Record<string, unknown>;
}

export interface ParsedDigestPayload {
  included: Array<Omit<DigestCard, 'label'>>;
  deferred: DeferredDigestItem[];
  /** Cards rejected for a real structural reason (missing required field,
   * wrong type). The caller accounts for them as deferred so the incident
   * falls back to its receipt; rejection never fails the run. */
  rejected: DeferredDigestItem[];
  /** Rejections that carried no usable identity, so they could not be attached
   * to a frozen candidate. The caller cannot name the incident they belong to,
   * so it defers whatever stayed unaccounted rather than failing the run. */
  unidentifiedRejections: number;
  warnings: DigestPayloadWarning[];
}

/** Identity read without validation: a card that fails to parse must still be
 * nameable in its diagnostic and attachable to its frozen candidate. */
function looseIdentity(value: Record<string, unknown>): { errorGroupId?: string; episodeId?: string } {
  const errorGroupId = typeof value['errorGroupId'] === 'string' ? value['errorGroupId'].trim() : '';
  const episodeId = typeof value['episodeId'] === 'string' ? value['episodeId'].trim() : '';
  return {
    ...(errorGroupId === '' ? {} : { errorGroupId }),
    ...(episodeId === '' ? {} : { episodeId }),
  };
}

/** Unknown keys are dropped, never fatal: the writer model echoing one extra
 * field (observed live: `replaySessionId` copied off the candidate) used to
 * fail the entire payload, burning every model call in the job's retry budget
 * and delaying the whole digest. */
function withoutUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
  warnings: DigestPayloadWarning[],
  identity: Record<string, unknown> = {},
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (allowed.has(key)) {
      kept[key] = entry;
      continue;
    }
    warnings.push({
      message: `${label} contains unknown field ${key}; dropping it`,
      fields: { field: key, at: label, ...identity },
    });
  }
  return kept;
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function identity(value: Record<string, unknown>, label: string): { errorGroupId?: string; episodeId?: string } {
  const errorGroupId = value['errorGroupId'] === undefined
    ? undefined
    : text(value['errorGroupId'], `${label}.errorGroupId`);
  const episodeId = value['episodeId'] === undefined
    ? undefined
    : text(value['episodeId'], `${label}.episodeId`);
  if (errorGroupId === undefined && episodeId === undefined) {
    throw new Error(`${label} must contain errorGroupId or episodeId`);
  }
  return {
    ...(errorGroupId === undefined ? {} : { errorGroupId }),
    ...(episodeId === undefined ? {} : { episodeId }),
  };
}

/** label is absent from the model schema, but present when replaying a payload
 * already grounded and stored by the writer. */
const CARD_KEYS: ReadonlySet<string> = new Set([
  'errorGroupId', 'episodeId', 'title', 'copy', 'action',
  'claimedUsers', 'claimedOccurrences', 'accounts', 'prUrl', 'label',
]);
const DEFERRED_KEYS: ReadonlySet<string> = new Set(['errorGroupId', 'episodeId', 'reason']);

/** Parse the structural boundary. Failures are scoped to the card that caused
 * them: unknown fields are dropped, an unusable card is rejected on its own and
 * accounted for by the caller, and only a payload that is not a pair of arrays
 * fails the run. Grounding against frozen facts is a separate step because
 * those facts are run-specific. */
export function parseDigestPayload(raw: unknown): ParsedDigestPayload {
  const warnings: DigestPayloadWarning[] = [];
  const rejected: DeferredDigestItem[] = [];
  let unidentifiedRejections = 0;
  const rawRoot = record(raw, 'digest payload');
  const root = withoutUnknownKeys(rawRoot, new Set(['included', 'deferred']), 'digest payload', warnings);
  if (!Array.isArray(root['included']) || !Array.isArray(root['deferred'])) {
    throw new Error('digest payload included and deferred must be arrays');
  }
  const parseCard = (value: unknown, index: number): Omit<DigestCard, 'label'> => {
    const rawCard = record(value, `included[${index}]`);
    const card = withoutUnknownKeys(rawCard, CARD_KEYS, `included[${index}]`, warnings, looseIdentity(rawCard));
    const cardIdentity = identity(card, `included[${index}]`);
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
      ...cardIdentity,
      ...(title === undefined ? {} : { title }),
      copy,
      action,
      ...(typeof card['claimedUsers'] === 'number' ? { claimedUsers: card['claimedUsers'] } : {}),
      ...(typeof card['claimedOccurrences'] === 'number' ? { claimedOccurrences: card['claimedOccurrences'] } : {}),
      ...(Array.isArray(card['accounts']) ? { accounts: card['accounts'].map((account) => String(account).trim()) } : {}),
      ...(card['prUrl'] !== undefined ? { prUrl: text(card['prUrl'], `included[${index}].prUrl`) } : {}),
    };
  };
  const included: Array<Omit<DigestCard, 'label'>> = [];
  root['included'].forEach((value, index) => {
    const cardIdentity = typeof value === 'object' && value !== null && !Array.isArray(value)
      ? looseIdentity(value as Record<string, unknown>)
      : {};
    try {
      included.push(parseCard(value, index));
    } catch (error: unknown) {
      // Scoped to this card: its siblings still deliver, and the incident
      // reaches the digest as its receipt through the deferral below.
      warnings.push({
        message: `included[${index}] card rejected; delivering its receipt instead`,
        fields: { at: `included[${index}]`, ...cardIdentity, reason: failureMessage(error) },
      });
      if (cardIdentity.errorGroupId !== undefined || cardIdentity.episodeId !== undefined) {
        rejected.push({ ...cardIdentity, reason: REJECTED_CARD_REASON });
      } else {
        unidentifiedRejections += 1;
      }
    }
  });
  const deferred: DeferredDigestItem[] = [];
  root['deferred'].forEach((value, index) => {
    const label = `deferred[${index}]`;
    let rawItem: Record<string, unknown>;
    try {
      rawItem = record(value, label);
    } catch (error: unknown) {
      warnings.push({ message: `${label} dropped`, fields: { at: label, reason: failureMessage(error) } });
      return;
    }
    const itemIdentity = looseIdentity(rawItem);
    const item = withoutUnknownKeys(rawItem, DEFERRED_KEYS, label, warnings, itemIdentity);
    try {
      deferred.push({ ...identity(item, label), reason: text(item['reason'], `${label}.reason`) });
    } catch (error: unknown) {
      warnings.push({
        message: `${label} deferral rejected`,
        fields: { at: label, ...itemIdentity, reason: failureMessage(error) },
      });
      if (itemIdentity.errorGroupId !== undefined || itemIdentity.episodeId !== undefined) {
        rejected.push({ ...itemIdentity, reason: REJECTED_CARD_REASON });
      } else {
        unidentifiedRejections += 1;
      }
    }
  });
  return { included, deferred, rejected, unidentifiedRejections, warnings };
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
