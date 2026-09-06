import { logger } from '../logger.js';
import { createAnthropicModelPort, toolLoop, type ModelPricing } from '@opslane/agent-core';
import { createAnthropicClient } from '../anthropic-client.js';
import { getToolSpanAttributes, traceSpan } from '../tracing.js';
import type { AgentCompletionResult, AgentLoopConfig } from './types.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';

const MODEL_PRICING: Record<string, {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}> = {
  'claude-sonnet-4-6': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 },
  'claude-sonnet-4-20250514': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 },
  // Sonnet 5 is $2/$10. The increase to $3/$15 that was scheduled for
  // 2026-09-01 was cancelled, so this is the standing rate, not a promotion.
  // Keep in sync with the table in investigate.ts.
  'claude-sonnet-5': { input: 2, output: 10, cacheWrite: 2.50, cacheRead: 0.20 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.10 },
  'claude-opus-4-6': { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.50 },
};
const DEFAULT_PRICING = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 };

const unpricedModelsWarned = new Set<string>();

export function pricingFor(model: string): ModelPricing {
  const pricing = MODEL_PRICING[model];
  if (pricing) return pricing;
  // NARRATIVE_MODEL and the investigation model are operator-configurable, so an
  // unlisted name silently bills two ledger phases at Sonnet 4.6 rates. Say so
  // once per model rather than writing fabricated costs in silence.
  if (!unpricedModelsWarned.has(model)) {
    unpricedModelsWarned.add(model);
    logger.warn('No pricing entry for model; billing job_usage at the default rate', { model });
  }
  return DEFAULT_PRICING;
}

export async function runAgentLoop(
  config: AgentLoopConfig,
  userMessage: string,
): Promise<AgentCompletionResult> {
  const client = createAnthropicClient(config.apiKey);
  const model = config.model ?? DEFAULT_MODEL;
  const port = createAnthropicModelPort(client, { maxTokens: 16384 });

  return toolLoop(port, {
    model,
    systemPrompt: config.systemPrompt,
    userMessage,
    maxTurns: config.maxTurns,
    tools: config.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      schema: tool.inputSchema,
      execute: tool.execute,
    })),
    state: config.externalState,
    middleware: config.middleware,
    onEvent: config.onEvent,
    signal: config.abortSignal,
    budgetUsd: config.budgetUsd,
    pricing: pricingFor(model),
    traceTool: (name, input, execute) => traceSpan(
      `tool:${name}`,
      getToolSpanAttributes(name, input),
      execute,
    ),
  });
}
