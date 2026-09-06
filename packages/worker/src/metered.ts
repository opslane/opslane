import { calculateCost } from '@opslane/agent-core';
import { recordJobUsage, type TokenUsage, type UsagePhase } from './db.js';
import { pricingFor } from './harness/agent-loop.js';
import { logger, safeErrorMessage } from './logger.js';

type RecordFn = (entry: {
  jobId: string;
  execution: number;
  phase: UsagePhase;
  model: string;
  usage: TokenUsage;
  costUsd: number;
}) => Promise<void>;

/** Aggregate one job phase into a single immutable ledger row per model. */
export class PhaseMeter {
  private readonly totals = new Map<string, TokenUsage>();
  private flushing: Promise<void> | null = null;
  private sealed = false;
  private flushed = false;

  constructor(
    private readonly opts: {
      jobId: string;
      execution: number;
      phase: UsagePhase;
      record?: RecordFn;
    },
  ) {}

  add(model: string, usage: TokenUsage): void {
    if (this.sealed) {
      logger.error('phase meter received usage after flush', {
        job_id: this.opts.jobId,
        phase: this.opts.phase,
        model,
      });
      return;
    }
    const prior = this.totals.get(model);
    if (!prior) {
      this.totals.set(model, { ...usage });
      return;
    }
    prior.input += usage.input;
    prior.output += usage.output;
    prior.cacheRead += usage.cacheRead;
    prior.cacheWrite += usage.cacheWrite;
  }

  /** Best-effort, idempotent, and retryable for injected writers that reject. */
  flush(): Promise<void> {
    this.sealed = true;
    if (this.flushed) return Promise.resolve();
    if (this.flushing) return this.flushing;
    this.flushing = this.doFlush().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    const record = this.opts.record ?? recordJobUsage;
    for (const [model, usage] of [...this.totals]) {
      try {
        await record({
          jobId: this.opts.jobId,
          execution: this.opts.execution,
          phase: this.opts.phase,
          model,
          usage,
          costUsd: Number(calculateCost(usage, pricingFor(model)).toFixed(4)),
        });
        this.totals.delete(model);
      } catch (err: unknown) {
        logger.error('phase meter flush failed', {
          job_id: this.opts.jobId,
          phase: this.opts.phase,
          model,
          error: safeErrorMessage(err),
        });
      }
    }
    this.flushed = this.totals.size === 0;
  }
}

/** Narrow an Anthropic response usage block into the ledger shape. */
export function usageFromResponse(response: unknown): TokenUsage {
  const usage = (response as { usage?: Record<string, unknown> } | null)?.usage;
  const read = (key: string): number => {
    const value = usage?.[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  };
  return {
    input: read('input_tokens'),
    output: read('output_tokens'),
    cacheRead: read('cache_read_input_tokens'),
    cacheWrite: read('cache_creation_input_tokens'),
  };
}
