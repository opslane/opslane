import { createHash } from 'node:crypto';

/** Strip query/hash; template numeric and UUID/hash-like path segments. */
export function normalizePageUrl(href: string): string {
  try {
    const url = new URL(href);
    const path = url.pathname
      .split('/')
      .filter((segment) => !segment.startsWith('_ctx_'))
      .map((segment) =>
        /^\d+$/.test(segment) || /^[0-9a-f-]{8,}$/i.test(segment) ? ':id' : segment,
      )
      .join('/');
    return `${url.origin}${path}`;
  } catch {
    return href.split(/[?#]/)[0] ?? href;
  }
}

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

export function frictionFingerprint(
  signalType: string,
  selector: string | null,
  pageUrl: string,
): string {
  const canonicalSelector = selector?.replace(
    /#react-select-(\d+)-[\w-]+/g,
    '#react-select-$1',
  ) ?? '';
  return createHash('sha256')
    .update(`${signalType}|${canonicalSelector}|${pageUrl}`)
    .digest('hex')
    .slice(0, 32);
}
