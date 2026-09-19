/** Generic UI status indicators and actions that should not be force-compared as duplicate candidates. */
export const GENERIC_UI_STRINGS = new Set([
  'loading',
  'please wait',
  'wait',
  'error',
  'errors',
  'warning',
  'warnings',
  'success',
  'info',
  'ok',
  'cancel',
  'submit',
  'save',
  'close',
  'done',
  'next',
  'back',
  'continue',
  'retry',
  'refresh',
  'empty',
  'none',
  'untitled',
  'na',
  'n/a',
]);

/**
 * Extracts quoted strings from arbitrary text.
 * Strips English contractions (e.g. didn't, wasn't, user's) so apostrophes in contractions
 * are never mistaken for quote delimiters.
 * Matches double quotes ("..."), single quotes ('...'), and curly quotes (“...” and ‘...’).
 */
export function extractQuotedStrings(text: string): string[] {
  if (!text || typeof text !== 'string') return [];
  // Strip English contractions so apostrophes inside words do not open/close quotes.
  const sanitized = text.replace(/\b[a-zA-Z]+'[a-zA-Z]+\b/g, '');
  const quotes: string[] = [];
  const regex = /["'“”‘’]([^"'“”‘’\r\n]+)["'“”‘’]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(sanitized)) !== null) {
    const raw = match[1]?.trim();
    if (raw) quotes.push(raw);
  }
  return quotes;
}

/**
 * Checks whether a quoted UI string is too generic to justify duplicate folding.
 * Generic strings include single/short tokens and common UI words like "Loading", "Error", "OK".
 */
export function isGenericUIString(str: string): boolean {
  const trimmed = str.trim();
  if (trimmed.length < 3) return true;
  const norm = trimmed.toLowerCase().replace(/[\s.!?…:]+/g, ' ').trim();
  if (norm.length < 3) return true;
  return GENERIC_UI_STRINGS.has(norm);
}

/**
 * Extracts all non-generic quoted UI strings from a list of text inputs.
 * Returns normalized (lowercase, trimmed) unique strings.
 */
export function extractNonGenericQuotedStrings(texts: readonly (string | null | undefined)[]): Set<string> {
  const results = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const quote of extractQuotedStrings(text)) {
      if (!isGenericUIString(quote)) {
        results.add(quote.trim().toLowerCase());
      }
    }
  }
  return results;
}
