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

/** Truncate, then neutralise any fence tag the text carries. */
export function fenced(text: string, max: number): string {
  const truncated = text.length > max ? `${text.slice(0, max)}... [truncated]` : text;
  return truncated.replace(/<\/?untrusted_(data|user_data)>/gi, '[fence]');
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
