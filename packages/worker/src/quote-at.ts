/** ±5-line window around a 1-based anchor, per-line trailing whitespace trimmed. */
const WINDOW = 5;

export function quoteWithinWindow(fileText: string, line: number, quote: string): boolean {
  const needle = quote.trim();
  if (!needle || !Number.isInteger(line) || line < 1) return false;
  const lines = fileText.split(/\r?\n/).map((entry) => entry.replace(/\s+$/u, ''));
  const start = Math.max(0, line - 1 - WINDOW);
  const window = lines.slice(start, line + WINDOW).join('\n');
  return window.includes(needle);
}
