import { createHash } from 'node:crypto';
import type { FrictionCategory } from '@opslane/shared';
import { ELEMENT_ANCHORED_CATEGORIES } from '../narrative/categories.js';
export { normalizePageUrl } from './urlnorm.js';

/** Normalized pathname only for session entry attribution. */
export function normalizeEntryPath(href: string): string | null {
  try {
    const url = new URL(href);
    const path = url.pathname
      .split('/')
      .filter((segment) => !segment.startsWith('_ctx_'))
      .map((segment) =>
        /^\d+$/.test(segment) || /^[0-9a-f-]{8,}$/i.test(segment) ? ':id' : segment,
      )
      .join('/');
    const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
    return trimmed === '' ? '/' : trimmed;
  } catch {
    return null;
  }
}

/** Positional pseudo-classes make the same element at a different DOM index
 * hash to a different bucket, so one UI defect splits into many findings that
 * each have to independently clear the promotion threshold. Strip them.
 * Deliberately no whitespace collapsing: it would rewrite the inside of quoted
 * attribute values and merge selectors that target different elements. */
export function canonicalizeSelector(selector: string | null): string {
  return (selector ?? '')
    .replace(/#react-select-(\d+)-[\w-]+/g, '#react-select-$1')
    .replace(/:nth-of-type\(\s*[^)]*\)/g, '')
    .replace(/:nth-child\(\s*[^)]*\)/g, '')
    .replace(/:nth-last-of-type\(\s*[^)]*\)/g, '')
    .replace(/:nth-last-child\(\s*[^)]*\)/g, '');
}

/** App-shell mount points appear in almost every SDK selector; anchoring on
 * them merges unrelated controls. */
const APP_SHELL_IDS = new Set(['#root', '#main', '#app', '#__next']);
/** Build-generated class shapes carry no stable element identity: compiled
 * atomic CSS (`_1e0c1txw`), CSS-modules default idents (`_button_x7f2b_1`),
 * and webpack-style hashed suffixes (`styles_button__2Xq9k`). The SDK's own
 * isDynamicClass filter (sdk selector.ts) strips a different, overlapping set
 * at capture time; these patterns cover what still reaches the worker. */
const COMPILED_CLASS_PATTERNS = [
  /^\._[a-z0-9]+$/i,
  /^\._?[\w-]*_[a-z0-9]{4,}_\d+$/i,
  /__[A-Za-z0-9]{5,}$/,
];
function isCompiledClass(token: string): boolean {
  return COMPILED_CLASS_PATTERNS.some((pattern) => pattern.test(token));
}
/** Ids minted per mount or per row are unstable. Short digit runs stay so
 * authored ids such as #step-12 remain useful. */
const GENERATED_ID = /^#react-select|\d{4,}/;
/** UI-state classes toggle on the same control and must not split it. */
const STATE_CLASSES = new Set([
  '.active', '.selected', '.disabled', '.enabled', '.open', '.closed',
  '.hover', '.focus', '.focused', '.loading', '.hidden', '.visible',
  '.checked', '.expanded', '.collapsed',
]);

function segmentTokens(segment: string): string[] {
  return segment.match(/#[\w-]+|\.[\w-]+|^[a-zA-Z][\w-]*/g) ?? [];
}

function semanticClasses(segment: string): string[] {
  return segmentTokens(segment).filter(
    (token) => token.startsWith('.')
      && !isCompiledClass(token)
      && !STATE_CLASSES.has(token.toLowerCase())
      && !/\d{4,}/.test(token),
  );
}

function tagOf(segment: string): string {
  return segment.match(/^[a-zA-Z][\w-]*/)?.[0] ?? '*';
}

/** Reduces an SDK CSS path to the most stable identity token it contains.
 * Tiers: raw unparseable selectors, semantic id, deepest semantic classes,
 * then a tag skeleton capped at the last three segments. */
export function anchorIdentity(selector: string | null): string {
  const canonical = canonicalizeSelector(selector);
  if (!canonical) return '';
  if (canonical.includes('[') || canonical.includes('\\')) {
    return `raw:${canonical}`;
  }
  const segments = canonical
    .split(/\s*>\s*|\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (segments.length === 0) return '';
  const leafIndex = segments.length - 1;
  const leafTag = tagOf(segments[leafIndex]!);
  // The leaf tag rides along whenever the identity token sits on an ancestor
  // (or is a bare class), so sibling controls under one container id or one
  // wrapper class do not collapse into a single fingerprint.
  for (let i = leafIndex; i >= 0; i--) {
    for (const token of segmentTokens(segments[i]!)) {
      if (!token.startsWith('#')) continue;
      if (APP_SHELL_IDS.has(token.toLowerCase()) || GENERATED_ID.test(token)) continue;
      return i === leafIndex ? `id:${token}` : `id:${token}>${leafTag}`;
    }
  }
  for (let i = leafIndex; i >= 0; i--) {
    const classes = semanticClasses(segments[i]!);
    if (classes.length > 0) {
      return `cls:${[...classes].sort().join('')}>${leafTag}`;
    }
  }
  return `skel:${segments.slice(-3).map(tagOf).join('>')}`;
}

export function observationFingerprint(
  category: FrictionCategory,
  selector: string | null,
  normalizedRoute: string,
): string {
  const anchor = ELEMENT_ANCHORED_CATEGORIES.has(category) && selector
    ? anchorIdentity(selector)
    : '';
  return createHash('sha256')
    .update(`${category}|${anchor}|${normalizedRoute}`)
    .digest('hex')
    .slice(0, 32);
}

export function frictionFingerprint(
  signalType: string,
  selector: string | null,
  pageUrl: string,
): string {
  return createHash('sha256')
    .update(`${signalType}|${canonicalizeSelector(selector)}|${pageUrl}`)
    .digest('hex')
    .slice(0, 32);
}
