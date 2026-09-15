import { parseTranscriptEvent, type RunStop, type RunUsage, type TranscriptEvent } from './schema.js';

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type LoggedEvent = DistributiveOmit<TranscriptEvent, 'at'>;

export const TRANSCRIPT_MAX_BYTES = 20_000_000;
/** The smallest supported cap: always larger than the reserve plus the longest stop line. */
export const MIN_TRANSCRIPT_BYTES = 4096;
/** Room always kept for the final stop line, so the cap covers the whole file. */
const STOP_RESERVE_BYTES = 512;

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Usage a provider or adapter reported, checked before it can change run totals or cost. */
function isValidUsage(value: unknown): value is RunUsage {
  if (typeof value !== 'object' || value === null) return false;
  const usage = value as Record<string, unknown>;
  return isCount(usage['input']) && isCount(usage['output']) && isCount(usage['cacheRead']) && isCount(usage['cacheWrite'])
    && (usage['thinking'] === undefined || isCount(usage['thinking']));
}

function addUsage(target: RunUsage, delta: RunUsage): void {
  target.input += delta.input;
  target.output += delta.output;
  target.cacheRead += delta.cacheRead;
  target.cacheWrite += delta.cacheWrite;
  if (delta.thinking !== undefined) target.thinking = (target.thinking ?? 0) + delta.thinking;
}

/** In-memory transcript for one run. Scrubs structured values on the way in; never throws. */
export class RunLogger {
  private readonly lines: string[] = [];
  private bytes = 0;
  private dropped = 0;
  private responses = 0;
  private capped = false;
  private readonly summed = new Map<string, RunUsage>();
  private replaced: Record<string, RunUsage> | null = null;
  private readonly maxBytes: number;
  private readonly now: () => Date;
  private readonly scrub: (value: unknown) => unknown;

  constructor(options: { maxBytes?: number; now?: () => Date; scrub?: (value: unknown) => unknown } = {}) {
    this.maxBytes = Number.isFinite(options.maxBytes)
      ? Math.max(MIN_TRANSCRIPT_BYTES, Math.floor(options.maxBytes!))
      : TRANSCRIPT_MAX_BYTES;
    this.now = options.now ?? (() => new Date());
    this.scrub = options.scrub ?? ((value) => value);
  }

  add(event: LoggedEvent): void {
    try {
      if (event.type === 'response') {
        this.responses++;
        if (isValidUsage(event.usage)) {
          const prior = this.summed.get(event.model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
          addUsage(prior, event.usage);
          this.summed.set(event.model, prior);
        }
      }
      if (this.capped) {
        this.dropped++;
        return;
      }
      const line = JSON.stringify(parseTranscriptEvent(this.scrub({ ...event, at: this.timestamp() })));
      const size = Buffer.byteLength(line, 'utf8') + 1;
      if (this.bytes + size > this.maxBytes - STOP_RESERVE_BYTES) {
        this.capped = true;
        this.dropped++;
        return;
      }
      this.lines.push(line);
      this.bytes += size;
    } catch {
      this.dropped++;
    }
  }

  /** Replace all usage with authoritative per-model totals (for example an SDK result's modelUsage). */
  replaceUsage(totals: Record<string, RunUsage>): void {
    try {
      if (!Object.values(totals).every(isValidUsage)) return;
      this.replaced = Object.fromEntries(Object.entries(totals).map(([model, usage]) => [model, {
        input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite,
        ...(usage.thinking === undefined ? {} : { thinking: usage.thinking }),
      }]));
    } catch {
      // A malformed provider total must not replace the accumulated response usage.
    }
  }

  usage(): Record<string, RunUsage> {
    if (this.replaced) return Object.fromEntries(Object.entries(this.replaced).map(([model, usage]) => [model, { ...usage }]));
    return Object.fromEntries([...this.summed].map(([model, usage]) => [model, { ...usage }]));
  }

  responseCount(): number {
    return this.responses;
  }

  private timestamp(): string {
    try {
      return this.now().toISOString();
    } catch {
      return new Date().toISOString();
    }
  }

  serialize(stop: RunStop): { jsonl: string; bytes: number; droppedEvents: number } {
    try {
      let droppedEvents = this.dropped;
      const lines = [...this.lines];
      let bytes = this.bytes;
      // Scrubbers can expand the stop line beyond the reserve. Account for the
      // actual serialized size and, if necessary, remove the last retained events.
      for (;;) {
        const stopLine = JSON.stringify(parseTranscriptEvent(this.scrub({
          type: 'stop',
          at: this.timestamp(),
          stop,
          ...(droppedEvents > 0 ? { transcriptTruncated: { droppedEvents } } : {}),
        })));
        const stopBytes = Buffer.byteLength(stopLine, 'utf8') + 1;
        if (bytes + stopBytes <= this.maxBytes) {
          const jsonl = `${[...lines, stopLine].join('\n')}\n`;
          return { jsonl, bytes: bytes + stopBytes, droppedEvents };
        }
        const removed = lines.pop();
        if (removed === undefined) break;
        bytes -= Buffer.byteLength(removed, 'utf8') + 1;
        droppedEvents++;
      }
    } catch {
      // Serialization or a caller-supplied scrubber may fail. Never emit an
      // unscrubbed fallback, and never let a logging failure escape into a job.
    }
    return { jsonl: '', bytes: 0, droppedEvents: this.dropped + this.lines.length + 1 };
  }
}
