import { logger } from './logger.js';

const MAX_VALUE_CODEPOINTS = 300;
const MAX_TEXT_BYTES = 8000;
// Mirror of the Go sender's bound: a mass sweep (e.g. legacy groups flipping
// to needs_human) must not open one 2s socket per group. Beyond the cap,
// events drop with a warn — the delivery contract is best-effort.
const MAX_IN_FLIGHT = 8;
let inFlight = 0;

export function sanitizeValue(s: string): string {
  const flat = s.replace(/\r\n|\r|\n/g, ' ');
  const escaped = flat.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const points = [...escaped];
  return points.length > MAX_VALUE_CODEPOINTS
    ? points.slice(0, MAX_VALUE_CODEPOINTS).join('') + '…'
    : escaped;
}

export function incidentUrlFor(errorGroupId: string, projectId: string): string {
  const base = process.env['DASHBOARD_URL'];
  if (!base || !/^https?:\/\//.test(base)) return '';
  return `${base.replace(/\/+$/, '')}/incidents/${encodeURIComponent(errorGroupId)}?project_id=${encodeURIComponent(projectId)}`;
}

export function emitUsageEvent(event: string, props: Record<string, string>): void {
  try {
    const url = process.env['USAGE_EVENTS_SLACK_WEBHOOK'];
    if (!url) return;

    const lines = [`*${sanitizeValue(event)}*`];
    for (const key of Object.keys(props).sort()) {
      lines.push(`${key}=${sanitizeValue(props[key] ?? '')}`);
    }
    let text = lines.join('\n');
    const enc = new TextEncoder();
    while (enc.encode(text).length > MAX_TEXT_BYTES && text.includes('\n')) {
      text = text.slice(0, text.lastIndexOf('\n'));
    }

    if (inFlight >= MAX_IN_FLIGHT) {
      safeWarn('usage event dropped: send queue full', { event });
      return;
    }
    // Create the request before counting it: a synchronously-throwing fetch
    // lands in the outer catch without ever incrementing, so the counter
    // cannot leak.
    const request = fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(2000),
    });
    inFlight += 1;
    void request.then((res) => {
      if (!res.ok) safeWarn('usage event rejected', { event, status: res.status });
    }).catch(() => {
      safeWarn('usage event send failed', { event });
    }).finally(() => {
      inFlight -= 1;
    });
  } catch {
    safeWarn('usage event emit failed', { event });
  }
}

function safeWarn(message: string, fields: Record<string, unknown>): void {
  try {
    logger.warn(message, fields);
  } catch {
    // Telemetry must never affect its caller.
  }
}
