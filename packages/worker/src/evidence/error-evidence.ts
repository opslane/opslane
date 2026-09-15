import { dropCutToken, maskPageUrl, maskStackLine, maskStructured, maskText } from './mask.js';

export const MAX_ERROR_TYPE_CHARS = 200;
export const MAX_ERROR_MESSAGE_CHARS = 500;
export const MAX_STACK_LINES = 30;
export const MAX_STACK_LINE_CHARS = 300;
export const MAX_BREADCRUMBS = 20;
export const MAX_BREADCRUMB_MESSAGE_CHARS = 300;
export const MAX_BREADCRUMB_DATA_CHARS = 300;
export const MAX_BREADCRUMB_LABEL_CHARS = 64;
export const MAX_PAGE_URL_CHARS = 500;
/** URLs are parsed before they are cut, so a long query string is dropped, not the whole URL. */
const MAX_PAGE_URL_INPUT = 8_192;

/** The same marker fenced() appends, so a prompt carries one spelling. */
export const TRUNCATED = '... [truncated]';

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

export interface BreadcrumbEvidence {
  timestamp: string;
  type: string;
  category: string;
  level: string | null;
  message: string;
  data: string | null;
}

/** The error an inquiry decides about, bounded and masked, never fenced here. */
export interface ErrorEvidence {
  type: string;
  message: string;
  /** First raw stack lines as captured, often minified. */
  stack: string[];
  stackLinesOmitted: number;
  /** The breadcrumbs nearest the error, oldest first. */
  breadcrumbs: BreadcrumbEvidence[];
  breadcrumbsOmitted: number;
  pageUrl: string | null;
}

export interface ErrorEventText {
  errorType: string;
  errorMessage: string;
  stackTraceRaw: string;
  /** error_events.breadcrumbs as pg returns JSONB: already parsed, shape unknown. */
  breadcrumbs: unknown;
  pageUrl: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Every field is masked over this window before it is cut to its budget. Far
 * wider than any budget, so a credential crossing the window edge would have
 * to be thousands of characters long to reach the kept text.
 */
const MASK_WINDOW = 8_192;

/**
 * Mask, then cut to the field budget, marker included.
 *
 * A hostile field is first sliced to the mask window so masking work stays
 * bounded, and the value that slice went through is dropped: a severed email
 * no longer matches its pattern. Masking runs before the final cut for the
 * same reason.
 */
function bounded(text: string, max: number, mask: (value: string) => string = maskText): string {
  const preBound = MASK_WINDOW;
  const cut = text.length > preBound;
  const masked = mask(cut ? dropCutToken(text.slice(0, preBound)) : text);
  if (!cut && masked.length <= max) return masked;
  return `${masked.slice(0, max - TRUNCATED.length)}${TRUNCATED}`;
}

/** Cut already-masked text to its budget, marker included. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - TRUNCATED.length)}${TRUNCATED}`;
}

function label(value: unknown): string {
  return typeof value === 'string' ? bounded(value, MAX_BREADCRUMB_LABEL_CHARS) : '';
}

/** Breadcrumbs are arbitrary JSON; a timestamp that is neither a number nor a date is dropped. */
function timestamp(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && ISO_TIMESTAMP.test(value)) return value;
  return '';
}

function breadcrumb(raw: Record<string, unknown>): BreadcrumbEvidence {
  const data = raw['data'];
  return {
    timestamp: timestamp(raw['timestamp']),
    type: label(raw['type']),
    category: label(raw['category']),
    level: typeof raw['level'] === 'string' ? label(raw['level']) : null,
    message: typeof raw['message'] === 'string'
      ? bounded(raw['message'], MAX_BREADCRUMB_MESSAGE_CHARS)
      : '',
    data: isRecord(data) ? clip(JSON.stringify(maskStructured(data)), MAX_BREADCRUMB_DATA_CHARS) : null,
  };
}

/**
 * The first non-blank stack lines and a count of the rest, found by scanning
 * for newlines. An event can carry a stack of up to a megabyte, and splitting
 * it would copy every line only to keep thirty.
 */
function firstStackLines(raw: string): { kept: string[]; total: number } {
  const kept: string[] = [];
  let total = 0;
  let start = 0;
  while (start <= raw.length) {
    const newline = raw.indexOf('\n', start);
    const end = newline === -1 ? raw.length : newline;
    if (raw.slice(start, Math.min(end, start + MASK_WINDOW)).trim() !== '') {
      total += 1;
      // One character past the window, so bounded() still marks the cut.
      if (kept.length < MAX_STACK_LINES) kept.push(raw.slice(start, Math.min(end, start + MASK_WINDOW + 1)));
    }
    if (newline === -1) break;
    start = newline + 1;
  }
  return { kept, total };
}

/** The last breadcrumb objects, oldest first, and how many objects came before them. */
function lastBreadcrumbs(raw: unknown): { recent: Record<string, unknown>[]; total: number } {
  if (!Array.isArray(raw)) return { recent: [], total: 0 };
  const recent: Record<string, unknown>[] = [];
  let total = 0;
  for (let index = raw.length - 1; index >= 0; index -= 1) {
    const crumb: unknown = raw[index];
    if (!isRecord(crumb)) continue;
    total += 1;
    if (recent.length < MAX_BREADCRUMBS) recent.unshift(crumb);
  }
  return { recent, total };
}

/** Bound and mask one captured error event for a model prompt. */
export function buildErrorEvidence(input: ErrorEventText): ErrorEvidence {
  const stack = firstStackLines(input.stackTraceRaw);
  const crumbs = lastBreadcrumbs(input.breadcrumbs);
  return {
    type: bounded(input.errorType, MAX_ERROR_TYPE_CHARS),
    message: bounded(input.errorMessage, MAX_ERROR_MESSAGE_CHARS),
    stack: stack.kept.map((line) => bounded(line.trimEnd(), MAX_STACK_LINE_CHARS, maskStackLine)),
    stackLinesOmitted: stack.total - stack.kept.length,
    breadcrumbs: crumbs.recent.map(breadcrumb),
    breadcrumbsOmitted: crumbs.total - crumbs.recent.length,
    pageUrl: input.pageUrl === null
      ? null
      : clip(maskPageUrl(input.pageUrl.slice(0, MAX_PAGE_URL_INPUT)), MAX_PAGE_URL_CHARS),
  };
}
