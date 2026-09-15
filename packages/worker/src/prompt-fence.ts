/**
 * The one place untrusted text is made safe to put inside a prompt fence.
 *
 * Every prompt in this worker wraps attacker-influenced text — the error
 * message, the stack trace, breadcrumbs, page context, repository content — in
 * an `<untrusted_data>` or `<untrusted_user_data>` block so the model can tell
 * evidence from instructions. That fence is only a boundary if the text cannot
 * close it. `JSON.stringify` and truncation do not close that hole: neither
 * escapes a literal `</untrusted_data>`, so a crafted error message ends the
 * fence early and everything after it reads as prompt structure.
 *
 * This lived in investigate.ts and nowhere else, which left the fix agent's
 * prompt — the one driving an agent that holds `write`, `edit`, `patch` and
 * `bash` — interpolating `errorMessage` and `stackTrace` raw. Both arrive
 * through the public `POST /api/v1/events` contract.
 */

/**
 * Truncate, then neutralise any fence tag the text carries, including
 * whitespace, attribute and newline variants a model could still read as a tag.
 *
 *
 * The tag is neutralised from its `<` through its name, so a variant with no
 * `>` at all is covered too. The optional tail is short and stops at a quote
 * or newline: an unbounded tail ran from `<untrusted_data` in one JSON field
 * to a `>` in a later one, deleting the evidence in between.
 * `\s*(?:\/\s*)?` rather than `\s*\/?\s*`: with no slash, the latter lets two
 * whitespace runs split the same spaces every possible way, which is quadratic
 * on a long run.
 */
export function fenced(text: string, max: number): string {
  const truncated = text.length > max ? `${text.slice(0, max)}... [truncated]` : text;
  return truncated.replace(
    /<\s*(?:\/\s*)?untrusted[_-](?:user[_-])?data\b\s*[^<>"\n]{0,64}>?/gi,
    '[fence]',
  );
}

/**
 * Collapse an untrusted value to a short single-line label.
 *
 * For values rendered as a name rather than a block — an environment name, a
 * runtime version. Stricter than `fenced`: it escapes the angle brackets
 * outright, so no tag survives in any form.
 */
export function escapeUntrustedLabel(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
