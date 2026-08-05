/**
 * Structured JSON logger for the worker service.
 *
 * Replaces console.log/console.error with structured JSON output,
 * consistent with the Go ingestion service's slog JSON format.
 */

let workerId = process.env['WORKER_ID'] ?? 'unknown';

/** Update the worker ID used in all subsequent log entries. */
export function setWorkerId(id: string): void {
  workerId = id;
}

export function log(
  level: 'info' | 'warn' | 'error',
  message: string,
  fields?: Record<string, unknown>
): void {
  const entry: Record<string, unknown> = {
    time: new Date().toISOString(),
    level: level.toUpperCase(),
    msg: message,
    worker_id: workerId,
  };

  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (key !== 'time' && key !== 'level' && key !== 'msg' && key !== 'worker_id') {
        entry[key] = value;
      }
    }
  }

  const output = JSON.stringify(entry);
  if (level === 'error') {
    process.stderr.write(output + '\n');
  } else {
    process.stdout.write(output + '\n');
  }
}

export const logger = {
  info(message: string, fields?: Record<string, unknown>): void {
    log('info', message, fields);
  },
  warn(message: string, fields?: Record<string, unknown>): void {
    log('warn', message, fields);
  },
  error(message: string, fields?: Record<string, unknown>): void {
    log('error', message, fields);
  },
};

/**
 * Convert an unknown thrown value to a loggable string without ever throwing.
 *
 * `String(Object.create(null))` raises TypeError, and a `message`/`toString`
 * getter can throw arbitrarily. A raw conversion inside a catch block would
 * therefore re-throw out of the handler — which is exactly the crash the
 * handlers exist to prevent.
 */
export function safeErrorMessage(err: unknown): string {
  try {
    if (err instanceof Error) {
      const message = err.message;
      return typeof message === 'string' ? message : 'unserializable error';
    }
    return String(err);
  } catch {
    return 'unserializable error';
  }
}
