import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DiagThrottle,
  normalizeDiagMessage,
  createDiagLogger,
  createRedactor,
} from '../tracing-diag.js';
import { logger } from '../logger.js';

describe('DiagThrottle', () => {
  it('admits the first occurrence of a fingerprint with no suppressed count', () => {
    expect(new DiagThrottle().admit('warn:boom', 1_000)).toBe(0);
  });

  it('drops repeats inside the window and reports the count after it', () => {
    const throttle = new DiagThrottle({ windowMs: 60_000 });
    expect(throttle.admit('warn:boom', 0)).toBe(0);
    expect(throttle.admit('warn:boom', 10_000)).toBeNull();
    expect(throttle.admit('warn:boom', 20_000)).toBeNull();
    expect(throttle.admit('warn:boom', 60_000)).toBe(2);
    expect(throttle.admit('warn:boom', 120_000)).toBe(0);
  });

  it('keeps distinct fingerprints independent', () => {
    // A noisy error must not mask a different, more important one.
    const throttle = new DiagThrottle({ windowMs: 60_000 });
    expect(throttle.admit('warn:noisy', 0)).toBe(0);
    expect(throttle.admit('warn:noisy', 1_000)).toBeNull();
    expect(throttle.admit('error:important', 1_000)).toBe(0);
  });

  it('drains outstanding suppressed counts and clears them', () => {
    const throttle = new DiagThrottle({ windowMs: 60_000 });
    throttle.admit('warn:boom', 0);
    throttle.admit('warn:boom', 1_000);
    throttle.admit('warn:boom', 2_000);
    expect(throttle.drain()).toEqual([{ fingerprint: 'warn:boom', suppressed: 2 }]);
    expect(throttle.drain()).toEqual([]);
  });

  it('reports suppressed counts on eviction instead of losing them', () => {
    const evicted: { fingerprint: string; suppressed: number }[] = [];
    const throttle = new DiagThrottle({
      windowMs: 60_000,
      maxEntries: 2,
      onEvict: (e) => evicted.push(e),
    });
    throttle.admit('a', 0);
    throttle.admit('a', 1_000); // suppressed = 1
    throttle.admit('b', 0);
    throttle.admit('c', 0); // evicts 'a', which still had a count
    expect(evicted).toEqual([{ fingerprint: 'a', suppressed: 1 }]);
    // 'a' was evicted, so it is treated as new rather than throttled.
    expect(throttle.admit('a', 2_000)).toBe(0);
  });

  it('does not report an eviction that had nothing suppressed', () => {
    const evicted: { fingerprint: string; suppressed: number }[] = [];
    const throttle = new DiagThrottle({ maxEntries: 2, onEvict: (e) => evicted.push(e) });
    throttle.admit('a', 0);
    throttle.admit('b', 0);
    throttle.admit('c', 0);
    expect(evicted).toEqual([]);
  });
});

describe('createRedactor', () => {
  it('removes literal secrets', () => {
    const redact = createRedactor(['sk-lf-supersecret', 'pk-lf-publicish']);
    expect(redact('failed with sk-lf-supersecret')).toBe('failed with [redacted]');
  });

  it('removes Langfuse-shaped keys it was never told about', () => {
    const redact = createRedactor([]);
    expect(redact('key sk-lf-abc123DEF-_x rejected')).toBe('key [redacted] rejected');
  });

  it('removes bearer tokens and whole authorization headers', () => {
    const redact = createRedactor([]);
    expect(redact('Bearer abc.def-123')).toBe('[redacted]');
    // The scheme AND the credential must go: a value-only pattern would leave
    // the base64 behind.
    expect(redact('authorization: Basic cGs6c2s=')).toBe('[redacted]');
  });

  it('redacts the base64 blob Langfuse actually sends', () => {
    // Langfuse authenticates with `Authorization: Basic base64(pk:sk)`. The
    // encoded form contains NEITHER plaintext key, so the literal pass cannot
    // catch it — this is the form the live credential travels in.
    const token = Buffer.from('pk-lf-public:sk-lf-secret').toString('base64');
    const redact = createRedactor([]);
    expect(redact(`Authorization: Basic ${token}`)).not.toContain(token);
  });

  it('redacts the JSON rendering OTel produces for exceptions', () => {
    // OTel's default error handler emits diag.error(JSON.stringify(...)), so
    // the header arrives quoted and a bare `\s*[:=]` never matches it.
    const token = Buffer.from('pk-lf-public:sk-lf-secret').toString('base64');
    const redact = createRedactor([]);
    const rendered = `{"status":401,"headers":{"authorization":"Basic ${token}"}}`;
    expect(redact(rendered)).not.toContain(token);
  });

  it('does not let one header swallow the rest of a collapsed message', () => {
    const redact = createRedactor([]);
    const out = redact('authorization: abc123 status=401 host=example.com');
    expect(out).toContain('status=401');
    expect(out).not.toContain('abc123');
  });

  it('redacts a configured secret regardless of how short it is', () => {
    // No length floor: a floor would exempt exactly the credentials we were
    // handed. Over-redaction is the cheaper failure.
    const redact = createRedactor(['abcd']);
    expect(redact('key abcd rejected')).toBe('key [redacted] rejected');
  });
});

describe('normalizeDiagMessage', () => {
  it('collapses whitespace and bounds length', () => {
    expect(normalizeDiagMessage('a\n  b', [])).toBe('a b');
    expect(normalizeDiagMessage('x'.repeat(900), []).length).toBe(500);
  });

  it('appends Error messages but discards all other arguments', () => {
    expect(normalizeDiagMessage('failed', [new Error('401 Unauthorized')])).toBe(
      'failed 401 Unauthorized',
    );
    expect(normalizeDiagMessage('failed', [{ authorization: 'Bearer sk-lf-secret' }])).toBe(
      'failed',
    );
  });

  it('survives a circular argument', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() => normalizeDiagMessage('failed', [circular])).not.toThrow();
    expect(normalizeDiagMessage('failed', [circular])).toBe('failed');
  });

  it('survives a hostile message and a throwing Error getter', () => {
    expect(() => normalizeDiagMessage(Object.create(null), [])).not.toThrow();
    const hostile = new Error('x');
    Object.defineProperty(hostile, 'message', {
      get() {
        throw new Error('nope');
      },
    });
    expect(() => normalizeDiagMessage('failed', [hostile])).not.toThrow();
  });

  it('applies the redactor before truncating', () => {
    const redact = createRedactor(['sk-lf-secret']);
    expect(normalizeDiagMessage('sent sk-lf-secret upstream', [], redact)).toBe(
      'sent [redacted] upstream',
    );
  });
});

describe('createDiagLogger', () => {
  const identity = (s: string): string => s;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('implements every DiagLogger method', () => {
    const diagLogger = createDiagLogger(new DiagThrottle(), identity);
    for (const method of ['verbose', 'debug', 'info', 'warn', 'error'] as const) {
      expect(typeof diagLogger[method]).toBe('function');
    }
  });

  it('drops verbose, debug, and info without logging', () => {
    const diagLogger = createDiagLogger(new DiagThrottle(), identity);
    diagLogger.verbose('v');
    diagLogger.debug('d');
    diagLogger.info('i');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('logs a warning with the otel component tag', () => {
    const diagLogger = createDiagLogger(new DiagThrottle(), identity, () => 0);
    diagLogger.warn('export failed');
    expect(warnSpy).toHaveBeenCalledWith('otel diag: export failed', { component: 'otel' });
  });

  it('redacts credentials out of diagnostics', () => {
    const diagLogger = createDiagLogger(
      new DiagThrottle(),
      createRedactor(['sk-lf-secret']),
      () => 0,
    );
    diagLogger.error('rejected', new Error('bad key sk-lf-secret'));
    const [message] = warnSpy.mock.calls[0] ?? [];
    expect(String(message)).not.toContain('sk-lf-secret');
  });

  it('includes the suppressed count once the window elapses', () => {
    let now = 0;
    const diagLogger = createDiagLogger(
      new DiagThrottle({ windowMs: 60_000 }),
      identity,
      () => now,
    );
    diagLogger.warn('export failed');
    now = 1_000;
    diagLogger.warn('export failed');
    now = 61_000;
    diagLogger.warn('export failed');
    expect(warnSpy).toHaveBeenLastCalledWith('otel diag: export failed', {
      component: 'otel',
      suppressed: 1,
    });
  });

  it('never throws into OTel even when the logger itself fails', () => {
    warnSpy.mockImplementation(() => {
      throw new Error('logger exploded');
    });
    const diagLogger = createDiagLogger(new DiagThrottle(), identity);
    expect(() => diagLogger.warn('export failed')).not.toThrow();
  });
});
