/**
 * OpenTelemetry diagnostic adapter.
 *
 * OTel routes exporter failures through `diag`, which is a no-op until a logger
 * is installed — that silence is why a misconfigured exporter ran unnoticed for
 * 33 hours in production.
 *
 * Three hazards shape this file. OTel calls each method as
 * `(message: string, ...args: unknown[])`, while `logger.log` JSON.stringifies
 * its fields unguarded, so forwarding arguments verbatim can throw on a
 * circular value — inside OTel's own call path. Exporter errors routinely quote
 * request material, so anything forwarded is redacted first. And nothing here
 * may throw: a diagnostic logger that raises breaks its caller.
 */

import type { DiagLogger } from '@opentelemetry/api';
import { logger, safeErrorMessage } from './logger.js';

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_FINGERPRINTS = 50;
const MAX_MESSAGE_LENGTH = 500;

/** Shapes that must never survive into a log line. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:pk|sk)-lf-[A-Za-z0-9_-]+/gi,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  // Consume the rest of the line. A value-only `\S+` stops at the first space
  // and would leave the credential behind in `authorization: Basic <base64>`.
  /\bauthorization\b\s*[:=].*/gi,
];

export interface DiagThrottleOptions {
  windowMs?: number;
  maxEntries?: number;
  /** Called when a capped-out entry is dropped while still holding a count. */
  onEvict?: (evicted: { fingerprint: string; suppressed: number }) => void;
}

interface ThrottleEntry {
  lastEmittedAt: number;
  suppressed: number;
}

/**
 * Per-fingerprint rate limiter. Throttling globally would let one noisy error
 * mask a different, more important one for a whole window.
 */
export class DiagThrottle {
  private readonly entries = new Map<string, ThrottleEntry>();
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly onEvict?: (evicted: { fingerprint: string; suppressed: number }) => void;

  constructor(options: DiagThrottleOptions = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_FINGERPRINTS;
    this.onEvict = options.onEvict;
  }

  /** Suppressed count to report, or null when the line should be dropped. */
  admit(fingerprint: string, now: number): number | null {
    const entry = this.entries.get(fingerprint);
    if (entry === undefined) {
      this.evictIfFull();
      this.entries.set(fingerprint, { lastEmittedAt: now, suppressed: 0 });
      return 0;
    }
    if (now - entry.lastEmittedAt >= this.windowMs) {
      const suppressed = entry.suppressed;
      entry.lastEmittedAt = now;
      entry.suppressed = 0;
      return suppressed;
    }
    entry.suppressed += 1;
    return null;
  }

  /** Outstanding counts, cleared as they are returned. */
  drain(): { fingerprint: string; suppressed: number }[] {
    const out: { fingerprint: string; suppressed: number }[] = [];
    for (const [fingerprint, entry] of this.entries) {
      if (entry.suppressed > 0) out.push({ fingerprint, suppressed: entry.suppressed });
      entry.suppressed = 0;
    }
    return out;
  }

  /** Evicting silently would discard a count drain() promised to deliver. */
  private evictIfFull(): void {
    if (this.entries.size < this.maxEntries) return;
    const oldest = this.entries.keys().next();
    if (oldest.done) return;
    const fingerprint = oldest.value;
    const entry = this.entries.get(fingerprint);
    this.entries.delete(fingerprint);
    if (entry !== undefined && entry.suppressed > 0 && this.onEvict !== undefined) {
      try {
        this.onEvict({ fingerprint, suppressed: entry.suppressed });
      } catch {
        // Reporting an eviction must not break admission.
      }
    }
  }
}

/**
 * Build a redactor that strips known credential values and credential-shaped
 * substrings. Literal matching uses split/join so no regex escaping is needed.
 */
export function createRedactor(secrets: readonly string[]): (text: string) => string {
  // No length floor. An explicitly configured credential is always redacted:
  // over-redacting a log line is strictly cheaper than leaking a key, and a
  // floor would silently exempt exactly the credentials we were handed.
  const literals = secrets.filter((s) => s.length > 0);
  return (text: string): string => {
    let out = text;
    for (const literal of literals) out = out.split(literal).join('[redacted]');
    for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]');
    return out;
  };
}

/**
 * Bounded, whitespace-collapsed, redacted string. Only `Error` arguments
 * contribute; every other argument is discarded rather than serialized.
 * Redaction runs before truncation so a secret cannot survive as a fragment.
 */
export function normalizeDiagMessage(
  message: unknown,
  args: unknown[],
  redact: (text: string) => string = (text) => text,
): string {
  const parts = [safeErrorMessage(message)];
  for (const arg of args) {
    if (arg instanceof Error) parts.push(safeErrorMessage(arg));
  }
  const joined = parts.join(' ').replace(/\s+/g, ' ').trim();
  let redacted: string;
  try {
    redacted = redact(joined);
  } catch {
    redacted = '[redaction failed]';
  }
  return redacted.slice(0, MAX_MESSAGE_LENGTH);
}

export function createDiagLogger(
  throttle: DiagThrottle,
  redact: (text: string) => string,
  now: () => number = Date.now,
): DiagLogger {
  const emit =
    (level: 'warn' | 'error') =>
    (message: string, ...args: unknown[]): void => {
      try {
        const text = normalizeDiagMessage(message, args, redact);
        const suppressed = throttle.admit(`${level}:${text}`, now());
        if (suppressed === null) return;
        const fields: Record<string, unknown> = { component: 'otel' };
        if (suppressed > 0) fields['suppressed'] = suppressed;
        logger.warn(`otel diag: ${text}`, fields);
      } catch {
        // A diagnostic logger must never throw into OTel.
      }
    };

  const drop = (): void => {};

  return {
    verbose: drop,
    debug: drop,
    info: drop,
    warn: emit('warn'),
    error: emit('error'),
  };
}
