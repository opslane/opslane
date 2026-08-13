import { createHash } from 'node:crypto';
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
function canonicalizeSelector(selector: string | null): string {
  return (selector ?? '')
    .replace(/#react-select-(\d+)-[\w-]+/g, '#react-select-$1')
    .replace(/:nth-of-type\(\s*[^)]*\)/g, '')
    .replace(/:nth-child\(\s*[^)]*\)/g, '')
    .replace(/:nth-last-of-type\(\s*[^)]*\)/g, '')
    .replace(/:nth-last-child\(\s*[^)]*\)/g, '');
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
