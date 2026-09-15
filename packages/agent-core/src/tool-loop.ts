import type {
  MessagePart,
  ModelMessage,
  ModelPort,
  ModelUsage,
  ToolResultPart,
  ToolSpec,
  ToolUsePart,
} from './model-port.js';

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  output: string;
  isError?: boolean;
}

export interface ToolHistoryEntry {
  name: string;
  input: Record<string, unknown>;
}

export interface AgentState {
  turnCount: number;
  toolCallCount: number;
  editCounts: Map<string, number>;
  testsRan: boolean;
  gaveUp: boolean;
  giveUpReason?: { reason_code: string; reason_message: string; remediation: string };
  tokenUsage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  stackTraceFiles: string[];
  scopeReviewDone: boolean;
  toolHistoryEntries: ToolHistoryEntry[];
}

export interface AgentCompletionResult {
  success: boolean;
  summary: string;
  toolCallCount: number;
  turnCount: number;
  testsRan: boolean;
  tokenUsage: AgentState['tokenUsage'];
  toolHistory: ToolHistoryEntry[];
}

export interface ToolMiddleware {
  preTool?: (call: ToolCall, state: AgentState) => Promise<{ allow: boolean; inject?: string } | void>;
  postTool?: (call: ToolCall, result: ToolResult, state: AgentState) => Promise<void>;
  preCompletion?: (state: AgentState) => Promise<{ inject?: string } | void>;
}

export type AgentEvent =
  | { type: 'message'; content: string }
  | { type: 'injected'; content: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; output: string; isError?: boolean }
  | { type: 'turn_start'; turnNumber: number }
  | { type: 'turn_end'; turnNumber: number; tokenUsage: AgentState['tokenUsage'] }
  | { type: 'completed'; summary: string }
  | { type: 'error'; code: string; message: string };

export interface ModelPricing {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export interface ToolLoopOptions {
  model: string;
  systemPrompt: string;
  userMessage: string;
  maxTurns: number;
  tools: ToolSpec[];
  state?: AgentState;
  middleware?: ToolMiddleware;
  onEvent(event: AgentEvent): void;
  signal?: AbortSignal;
  budgetUsd?: number;
  pricing: ModelPricing;
  traceTool?: (
    name: string,
    input: Record<string, unknown>,
    execute: () => Promise<string>,
  ) => Promise<string>;
  redact?: (text: string) => string;
}

export async function toolLoop(port: ModelPort, options: ToolLoopOptions): Promise<AgentCompletionResult> {
  const redact = options.redact ?? identity;
  const emit = (event: AgentEvent): void => options.onEvent(redactEvent(event, redact));
  const state = options.state ?? createAgentState();
  const toolMap = new Map(options.tools.map((tool) => [tool.name, tool]));
  const messages: ModelMessage[] = [{
    role: 'user' as const,
    content: [{ type: 'text' as const, text: redact(options.userMessage) }],
  }];
  let lastAssistantText = '';

  while (state.turnCount < options.maxTurns) {
    state.turnCount++;
    emit({ type: 'turn_start', turnNumber: state.turnCount });

    if (options.signal?.aborted) {
      emit({ type: 'error', code: 'CANCELLED', message: 'Run was cancelled' });
      return toResult(false, 'Cancelled', state, redact);
    }

    let response;
    try {
      response = await port.generate({
        model: options.model,
        system: [{ text: redact(options.systemPrompt), cache: true }],
        messages,
        tools: options.tools.map(({ name, description, schema }) => ({ name, description, schema })),
        signal: options.signal,
      });
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : String(error));
      emit({ type: 'error', code: classifyApiError(error), message });
      return toResult(false, message, state, redact);
    }

    addUsage(state, response.usage);
    if (options.budgetUsd != null) {
      const cost = calculateCost(state.tokenUsage, options.pricing);
      if (cost > options.budgetUsd) {
        emit({
          type: 'error',
          code: 'BUDGET_EXCEEDED',
          message: `Budget exceeded: $${cost.toFixed(4)} > $${options.budgetUsd}`,
        });
        return toResult(false, 'Budget exceeded', state, redact);
      }
    }

    const assistantContent = redactAssistantContent(response.content, redact);
    const toolCalls: ToolUsePart[] = [];
    for (const block of assistantContent) {
      if (block.type === 'text') {
        lastAssistantText = block.text;
        emit({ type: 'message', content: block.text });
      } else {
        toolCalls.push(block);
        emit({ type: 'tool_call', id: block.id, name: block.name, input: block.input });
      }
    }
    messages.push({ role: 'assistant', content: assistantContent });

    if (response.stopReason === 'end_turn' || toolCalls.length === 0) {
      const check = await options.middleware?.preCompletion?.(state);
      if (check?.inject) {
        messages.push({
          role: 'user',
          content: [{ type: 'text', text: redact(check.inject) }],
        });
        emit({ type: 'injected', content: redact(check.inject) });
        emit({ type: 'turn_end', turnNumber: state.turnCount, tokenUsage: { ...state.tokenUsage } });
        continue;
      }

      emit({ type: 'completed', summary: lastAssistantText });
      emit({ type: 'turn_end', turnNumber: state.turnCount, tokenUsage: { ...state.tokenUsage } });
      return toResult(true, lastAssistantText, state, redact);
    }

    const toolResults: ToolResultPart[] = [];
    for (const toolCall of toolCalls) {
      state.toolCallCount++;
      const safeCall: ToolCall = {
        id: toolCall.id,
        name: redact(toolCall.name),
        input: redactRecord(toolCall.input, redact),
      };
      state.toolHistoryEntries.push({ name: safeCall.name, input: safeCall.input });
      const tool = toolMap.get(toolCall.name);

      if (!tool) {
        const output = redact(`Error: Unknown tool "${toolCall.name}"`);
        emit({ type: 'tool_result', id: toolCall.id, name: safeCall.name, output, isError: true });
        toolResults.push({ type: 'tool_result', toolUseId: toolCall.id, output, isError: true });
        continue;
      }

      const pre = await options.middleware?.preTool?.(safeCall, state);
      if (pre?.allow === false) {
        const output = redact(pre.inject ?? 'Tool call blocked by middleware.');
        emit({ type: 'tool_result', id: toolCall.id, name: safeCall.name, output, isError: true });
        toolResults.push({ type: 'tool_result', toolUseId: toolCall.id, output, isError: true });
        continue;
      }

      let output: string;
      let isError = false;
      try {
        const execute = async (): Promise<string> => {
          try {
            return redact(String(await tool.execute(toolCall.input)));
          } catch (error) {
            // The tracing collaborator observes callback failures, so sanitize
            // before the exception crosses that boundary. Do not retain the raw
            // error as `cause`, because exporters may serialize it.
            throw new Error(redact(error instanceof Error ? error.message : String(error)));
          }
        };
        output = await (options.traceTool
          ? options.traceTool(safeCall.name, safeCall.input, execute)
          : execute());
      } catch (error) {
        output = `Error: ${error instanceof Error ? error.message : String(error)}`;
        isError = true;
      }
      output = redact(output);

      emit({ type: 'tool_result', id: toolCall.id, name: safeCall.name, output, isError });
      toolResults.push({ type: 'tool_result', toolUseId: toolCall.id, output, isError });
      await options.middleware?.postTool?.(
        safeCall,
        { id: toolCall.id, output, isError },
        state,
      );

      if (state.gaveUp) {
        const summary = redact(state.giveUpReason?.reason_message ?? 'Agent gave up');
        emit({ type: 'completed', summary });
        emit({ type: 'turn_end', turnNumber: state.turnCount, tokenUsage: { ...state.tokenUsage } });
        return toResult(true, summary, state, redact);
      }
    }

    messages.push({ role: 'user', content: toolResults });
    emit({ type: 'turn_end', turnNumber: state.turnCount, tokenUsage: { ...state.tokenUsage } });
  }

  emit({ type: 'error', code: 'MAX_TURNS_EXCEEDED', message: `Reached maximum of ${options.maxTurns} turns` });
  return toResult(false, lastAssistantText || 'Max turns exceeded', state, redact);
}

export function calculateCost(usage: AgentState['tokenUsage'], pricing: ModelPricing): number {
  return (
    (usage.input / 1_000_000) * pricing.input
    + (usage.output / 1_000_000) * pricing.output
    + (usage.cacheWrite / 1_000_000) * pricing.cacheWrite
    + (usage.cacheRead / 1_000_000) * pricing.cacheRead
  );
}

export function classifyApiError(error: unknown): string {
  if (!(error instanceof Error)) return 'AGENT_CRASHED';
  const message = error.message.toLowerCase();
  if (message.includes('rate') || message.includes('429')) return 'API_RATE_LIMITED';
  if (message.includes('auth') || message.includes('401') || message.includes('invalid api key')) return 'API_KEY_INVALID';
  if (message.includes('timeout') || message.includes('timed out')) return 'TIMEOUT';
  return 'AGENT_CRASHED';
}

function createAgentState(): AgentState {
  return {
    turnCount: 0,
    toolCallCount: 0,
    editCounts: new Map(),
    testsRan: false,
    gaveUp: false,
    tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    stackTraceFiles: [],
    scopeReviewDone: false,
    toolHistoryEntries: [],
  };
}

function addUsage(state: AgentState, usage: ModelUsage): void {
  state.tokenUsage.input += usage.inputTokens;
  state.tokenUsage.output += usage.outputTokens;
  state.tokenUsage.cacheRead += usage.cacheReadTokens;
  state.tokenUsage.cacheWrite += usage.cacheWriteTokens;
}

function toResult(
  success: boolean,
  summary: string,
  state: AgentState,
  redact: (text: string) => string,
): AgentCompletionResult {
  return {
    success,
    summary: redact(summary),
    toolCallCount: state.toolCallCount,
    turnCount: state.turnCount,
    testsRan: state.testsRan,
    tokenUsage: { ...state.tokenUsage },
    toolHistory: state.toolHistoryEntries.map((entry) => ({
      name: redact(entry.name),
      input: redactRecord(entry.input, redact),
    })),
  };
}

function redactAssistantContent(
  content: Array<Extract<MessagePart, { type: 'text' | 'tool_use' }>>,
  redact: (text: string) => string,
): Array<Extract<MessagePart, { type: 'text' | 'tool_use' }>> {
  return content.map((part) => part.type === 'text'
    ? { type: 'text', text: redact(part.text) }
    : {
        type: 'tool_use',
        id: redact(part.id),
        name: redact(part.name),
        input: redactRecord(part.input, redact),
      });
}

function redactEvent(event: AgentEvent, redact: (text: string) => string): AgentEvent {
  switch (event.type) {
    case 'injected':
    case 'message': return { ...event, content: redact(event.content) };
    case 'tool_call': return {
      ...event,
      id: redact(event.id),
      name: redact(event.name),
      input: redactRecord(event.input, redact),
    };
    case 'tool_result': return {
      ...event,
      id: redact(event.id),
      name: redact(event.name),
      output: redact(event.output),
    };
    case 'completed': return { ...event, summary: redact(event.summary) };
    case 'error': return { ...event, code: redact(event.code), message: redact(event.message) };
    default: return event;
  }
}

function redactRecord(
  value: Record<string, unknown>,
  redact: (text: string) => string,
): Record<string, unknown> {
  return redactValue(value, redact) as Record<string, unknown>;
}

function redactValue(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, redact));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), redactValue(item, redact)]));
  }
  return value;
}

function identity(text: string): string {
  return text;
}
