/** ±WINDOW lines around a 1-based anchor, per-line trailing whitespace trimmed. */
export const WINDOW = 5;

export function quoteWithinWindow(fileText: string, line: number, quote: string): boolean {
  // Normalize the needle the same way as the haystack: split on either line
  // ending and trim per-line trailing whitespace. Without this, a multi-line
  // quote copied from a CRLF file could never match the LF-joined window and a
  // legitimately grounded citation would score ungrounded.
  const needle = quote
    .trim()
    .split(/\r?\n/)
    .map((entry) => entry.trimEnd())
    .join('\n');
  if (!needle || !Number.isInteger(line) || line < 1) return false;
  // trimEnd, not a /\s+$/ regex: the file is model-cited and can contain long
  // whitespace runs where that regex backtracks quadratically per line.
  const lines = fileText.split(/\r?\n/).map((entry) => entry.trimEnd());
  const start = Math.max(0, line - 1 - WINDOW);
  const window = lines.slice(start, line + WINDOW).join('\n');
  return window.includes(needle);
}
