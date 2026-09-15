import type { RepositoryRef, RunStop } from '@opslane/agent-runs';
import {
  readOnlyTools,
  RUN_COMMAND_DESCRIPTION,
  runReadOnlyAgentSdk,
  sdkToolLists,
  sdkMaxResubmits,
  type ReadOnlyRunInput,
  type ReadOnlyRunResult,
  type ReadOnlyStop,
} from '../harness/sdk-agent.js';
import type { RunContext } from './context.js';
import { withRunLog, type OpenRunOptions } from './handle.js';
import { countRunLogFailure } from './sink.js';

export interface SdkRequestDto {
  model: string;
  systemPrompt: string;
  firstMessage: string;
  tools: Array<{ name: string; description: string; inputSchema: unknown }>;
  terminalTool: { name: string; description: string; inputSchema: unknown };
}

/** The serializable first request of an SDK run. Live MCP handlers are not part of it. */
export function sdkRequestDto(input: ReadOnlyRunInput): SdkRequestDto {
  const tools = readOnlyTools().map((tool) => ({ name: tool.name, description: tool.description ?? '', inputSchema: tool.input_schema }));
  if (input.commandRunner) {
    tools.push({
      name: 'run_command',
      description: RUN_COMMAND_DESCRIPTION,
      inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    });
  }
  return {
    model: input.model,
    systemPrompt: input.systemPrompt,
    firstMessage: input.firstMessage,
    tools,
    terminalTool: { name: input.terminalTool.name, description: input.terminalTool.description ?? '', inputSchema: input.terminalTool.input_schema },
  };
}

export function sdkSettings(input: ReadOnlyRunInput): Record<string, unknown> {
  return {
    model: input.model,
    maxTurns: input.maxTurns,
    budgetUsd: input.budgetUsd,
    maxResubmits: sdkMaxResubmits(input),
    commandEnabled: input.commandRunner !== undefined,
    minFilesRead: input.classification?.minFilesRead ?? null,
    validatesTerminal: input.validateTerminal !== undefined,
    ...sdkToolLists(input),
  };
}

export function readOnlyStopToRunStop(stop: ReadOnlyStop): RunStop {
  switch (stop) {
    case 'terminal': return 'terminal_tool';
    case 'budget': return 'budget';
    case 'no_tool_call': return 'no_tool_call';
    case 'api_error': return 'api_error';
    case 'turns_exhausted': return 'turns_exhausted';
    case 'no_evidence': return 'no_evidence';
    case 'truncated': return 'truncated';
  }
}

export function runLoggedSdk(options: {
  context: RunContext | null;
  phase: string;
  entryPoint: string;
  structuredInput: unknown;
  repository?: RepositoryRef | null;
  commitSha?: string | null;
  input: ReadOnlyRunInput;
  classify?: (result: ReadOnlyRunResult) => RunStop;
}): Promise<ReadOnlyRunResult> {
  let logOptions: OpenRunOptions;
  try {
    logOptions = {
      context: options.context,
      phase: options.phase,
      entryPoint: options.entryPoint,
      models: [options.input.model],
      settings: sdkSettings(options.input),
      structuredInput: options.structuredInput,
      request: sdkRequestDto(options.input),
      repository: options.repository ?? null,
      commitSha: options.commitSha ?? null,
    };
  } catch {
    countRunLogFailure('setup');
    return runReadOnlyAgentSdk(options.input);
  }
  return withRunLog(
    logOptions,
    (run) => runReadOnlyAgentSdk(options.input, run),
    options.classify ?? ((result) => readOnlyStopToRunStop(result.stop)),
  );
}
