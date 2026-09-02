import type Anthropic from '@anthropic-ai/sdk';
import {
  createSdkMcpServer,
  query,
  tool,
  type Options,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { calculateCost } from '@opslane/agent-core';
import { z } from 'zod/v4';
import {
  executeListFiles,
  executeReadFile,
  executeSearch,
  type RepoReader,
} from '../investigate-tools.js';
import { logger } from '../logger.js';
import { annotateActiveSpan } from '../tracing.js';
import { pricingFor } from './agent-loop.js';
import { MachineUnavailableError } from './errors.js';

export interface CommandRunner {
  run(command: string): Promise<{ stdout: string; exitCode: number }>;
}

export interface ReadOnlyRunInput {
  apiKey: string;
  model: string;
  maxTurns: number;
  budgetUsd: number;
  /** Kept in the call-site contract; pricing is resolved by model to avoid drift. */
  pricing: { input: number; output: number; cacheWrite: number; cacheRead: number };
  systemPrompt: string;
  firstMessage: string;
  terminalTool: Anthropic.Tool;
  reader: RepoReader;
  commandRunner?: CommandRunner;
  classification?: { minFilesRead: number };
  validateTerminal?: (
    raw: Record<string, unknown>,
    context: { filesRead: string[] },
  ) => Promise<{ ok: true } | { ok: false; feedback: string }>
    | { ok: true } | { ok: false; feedback: string };
  maxResubmits?: number;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type ReadOnlyStop =
  | 'terminal'
  | 'budget'
  | 'no_tool_call'
  | 'api_error'
  | 'turns_exhausted'
  | 'no_evidence'
  | 'truncated';

export interface ReadOnlyRunResult {
  terminalInput: Record<string, unknown> | null;
  stop: ReadOnlyStop;
  apiErrorStatus?: number;
  apiErrorDetail?: string;
  filesRead: string[];
  lastModelText: string;
  costUsd: number;
  usage: TokenUsage;
}

/** Anthropic-shaped definitions retained for schema audits and documentation. */
export function readOnlyTools(): Anthropic.Tool[] {
  return [
    {
      name: 'read_file',
      description: 'Read a source file from the repository. Returns content with line numbers.',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Relative path from the repository root.' } },
        required: ['path'],
      },
    },
    {
      name: 'search',
      description: 'Search the repository with grep. Returns matching paths and line numbers.',
      input_schema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Basic regular expression.' },
          include: { type: 'string', description: 'Optional file glob such as *.vue.' },
        },
        required: ['pattern'],
      },
    },
    {
      name: 'list_files',
      description: 'List files and directories in the repository.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative directory; defaults to root.' },
          recursive: { type: 'boolean', description: 'Include one level of subdirectories.' },
        },
      },
    },
  ];
}

export async function callTool(
  name: 'read_file' | 'search' | 'list_files' | 'run_command',
  args: Record<string, unknown>,
  reader: RepoReader,
  commandRunner?: CommandRunner,
): Promise<string> {
  switch (name) {
    case 'read_file': return executeReadFile(reader, args);
    case 'search': return executeSearch(reader, args);
    case 'list_files': return executeListFiles(reader, args);
    case 'run_command': {
      const command = args['command'];
      if (typeof command !== 'string' || command.trim() === '') return 'Error: "command" parameter is required';
      if (!commandRunner) return 'Error: command execution is not available for this job';
      const result = await commandRunner.run(command);
      return `${result.stdout}${result.exitCode === 0 ? '' : `\n[exit ${result.exitCode}]`}`;
    }
  }
}

/**
 * Built-in tools this loop must never expose. The read-only jobs reach the
 * repository through the MCP server alone, whose handlers run inside the
 * machine; a built-in here would read and write the worker host instead.
 */
const DENIED_BUILTIN_TOOLS = [
  'Bash', 'BashOutput', 'KillShell', 'Read', 'Write', 'Edit', 'NotebookEdit',
  'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite', 'ToolSearch',
] as const;

interface RunState {
  captured: Record<string, unknown> | null;
  fatal: unknown;
  filesRead: Set<string>;
  rejectedSubmission: Record<string, unknown> | null;
  resubmitsUsed: number;
}

function resultText(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) };
}

function schemaShape(schema: Anthropic.Tool.InputSchema): Record<string, z.ZodType> {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  return Object.fromEntries(Object.entries(properties).map(([name, property]) => {
    const converted = z.fromJSONSchema(property as Record<string, unknown>);
    return [name, required.has(name) ? converted : converted.optional()];
  }));
}

function maxResubmits(input: ReadOnlyRunInput): number {
  const raw = input.maxResubmits ?? 2;
  return Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 0), 5) : 2;
}

function isFatal(error: unknown): boolean {
  return error instanceof MachineUnavailableError;
}

function buildServer(input: ReadOnlyRunInput, state: RunState) {
  const handle = async (
    name: 'read_file' | 'search' | 'list_files' | 'run_command',
    args: Record<string, unknown>,
  ) => {
    try {
      const output = await callTool(name, args, input.reader, input.commandRunner);
      if (name === 'read_file' && typeof args['path'] === 'string' && !output.startsWith('Error:')) {
        state.filesRead.add(args['path']);
      }
      return resultText(output, output.startsWith('Error:'));
    } catch (error: unknown) {
      if (isFatal(error)) {
        state.fatal = error;
        return resultText('The work machine is unavailable.', true);
      }
      return resultText(error instanceof Error ? error.message : String(error), true);
    }
  };

  const tools: NonNullable<Parameters<typeof createSdkMcpServer>[0]['tools']> = [
    tool('read_file', readOnlyTools()[0]!.description ?? '', { path: z.string() },
      (args) => handle('read_file', args)),
    tool('search', readOnlyTools()[1]!.description ?? '', {
      pattern: z.string(), include: z.string().optional(),
    }, (args) => handle('search', args)),
    tool('list_files', readOnlyTools()[2]!.description ?? '', {
      path: z.string().optional(), recursive: z.boolean().optional(),
    }, (args) => handle('list_files', args)),
  ];

  if (input.commandRunner) {
    tools.push(tool(
      'run_command',
      'Run one bounded shell command inside the isolated repository checkout. Use it to discover routes; read every cited file with read_file before submitting.',
      { command: z.string() },
      (args) => handle('run_command', args),
    ));
  }

  tools.push(tool(
    input.terminalTool.name,
    input.terminalTool.description ?? 'Submit the final result.',
    schemaShape(input.terminalTool.input_schema),
    async (raw) => {
      const submission = raw as Record<string, unknown>;
      const evidenceMissing = input.classification !== undefined
        && state.filesRead.size < input.classification.minFilesRead;
      const verdict = evidenceMissing
        ? { ok: false as const, feedback: `Read at least ${input.classification!.minFilesRead} supporting file(s) with read_file before submitting.` }
        : await input.validateTerminal?.(submission, { filesRead: [...state.filesRead] }) ?? { ok: true as const };
      if (!verdict.ok && state.resubmitsUsed < maxResubmits(input)) {
        state.resubmitsUsed++;
        state.rejectedSubmission = submission;
        return resultText(
          `Your submission was NOT recorded. ${verdict.feedback} Correct it and call ${input.terminalTool.name} again with the complete submission.`,
          true,
        );
      }
      state.captured = submission;
      return resultText('Submission recorded.');
    },
  ));

  return createSdkMcpServer({ name: 'repo', version: '1.0.0', tools, alwaysLoad: true });
}

export function buildQueryOptions(input: ReadOnlyRunInput, state?: RunState): Options {
  const runState = state ?? {
    captured: null, fatal: null, filesRead: new Set<string>(), rejectedSubmission: null, resubmitsUsed: 0,
  };
  const names = ['read_file', 'search', 'list_files'];
  if (input.commandRunner) names.push('run_command');
  names.push(input.terminalTool.name);
  return {
    model: input.model,
    systemPrompt: input.systemPrompt,
    maxTurns: input.maxTurns,
    // `tools: []` is what actually disables the built-ins; `disallowedTools`
    // names them anyway so the deny survives an SDK release that changes what
    // an empty `tools` means. Repository content steers this model, so the
    // built-in shell and filesystem must be denied twice, not once.
    tools: [],
    disallowedTools: [...DENIED_BUILTIN_TOOLS],
    allowedTools: names.map((name) => `mcp__repo__${name}`),
    permissionMode: 'dontAsk',
    settingSources: [],
    mcpServers: { repo: buildServer(input, runState) },
    // Only what the subprocess needs. Spreading process.env handed a
    // prompt-injectable agent the worker's GITHUB_TOKEN, E2B_API_KEY,
    // ENCRYPTION_KEY, DATABASE_URL and Slack webhook, with the built-in tool
    // deny as the only thing between them.
    env: {
      ...(process.env['PATH'] === undefined ? {} : { PATH: process.env['PATH'] }),
      ...(process.env['HOME'] === undefined ? {} : { HOME: process.env['HOME'] }),
      ANTHROPIC_API_KEY: input.apiKey,
      ...(process.env['ANTHROPIC_BASE_URL'] === undefined
        ? {}
        : { ANTHROPIC_BASE_URL: process.env['ANTHROPIC_BASE_URL'] }),
    },
  };
}

function usageFromMessage(message: SDKMessage): TokenUsage | null {
  if (message.type !== 'assistant') return null;
  const usage = message.message.usage;
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
  };
}

function addUsage(target: TokenUsage, delta: TokenUsage): void {
  target.input += delta.input;
  target.output += delta.output;
  target.cacheRead += delta.cacheRead;
  target.cacheWrite += delta.cacheWrite;
}

/** Run the SDK loop on the worker while every repository tool executes remotely. */
export async function runReadOnlyAgentSdk(input: ReadOnlyRunInput): Promise<ReadOnlyRunResult> {
  if (input.maxTurns <= 0) {
    annotateActiveSpan({
      'agent.stop': input.classification ? 'no_evidence' : 'turns_exhausted',
      'agent.cost_usd': 0,
      'agent.files_read': 0,
      'agent.input_tokens': 0,
      'agent.output_tokens': 0,
    });
    return {
      terminalInput: null,
      stop: input.classification ? 'no_evidence' : 'turns_exhausted',
      filesRead: [], lastModelText: '', costUsd: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  }
  const state: RunState = {
    captured: null, fatal: null, filesRead: new Set<string>(), rejectedSubmission: null, resubmitsUsed: 0,
  };
  const usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const seenUsage = new Map<string, TokenUsage>();
  let lastModelText = '';
  let stop: ReadOnlyStop = 'no_tool_call';
  let apiErrorStatus: number | undefined;
  let apiErrorDetail: string | undefined;
  // SDK 0.3.251 can yield a typed error result and then throw when its
  // subprocess exits non-zero. Once that result classified the failure, the
  // follow-on throw must not reinterpret it. Successful and truncated
  // messages do not set this guard because a later stream failure still wins.
  let typedErrorSeen = false;
  let costUsd = 0;
  const q = query({ prompt: input.firstMessage, options: buildQueryOptions(input, state) });

  try {
    for await (const message of q) {
      const next = usageFromMessage(message);
      if (next && message.type === 'assistant') {
        const id = message.message.id;
        const previous = seenUsage.get(id) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        addUsage(usage, {
          input: Math.max(0, next.input - previous.input),
          output: Math.max(0, next.output - previous.output),
          cacheRead: Math.max(0, next.cacheRead - previous.cacheRead),
          cacheWrite: Math.max(0, next.cacheWrite - previous.cacheWrite),
        });
        seenUsage.set(id, next);
        costUsd = calculateCost(usage, pricingFor(input.model));
        for (const block of message.message.content) {
          if (block.type === 'text') lastModelText = block.text;
        }
        if (message.error === 'max_output_tokens' || message.message.stop_reason === 'max_tokens') stop = 'truncated';
      }
      if (message.type === 'result') {
        if (message.subtype === 'error_max_turns') {
          stop = 'turns_exhausted';
          typedErrorSeen = true;
        } else if (message.subtype === 'error_max_budget_usd') {
          stop = 'budget';
          typedErrorSeen = true;
        } else if (message.subtype === 'success') {
          if (message.is_error) {
            stop = 'api_error';
            apiErrorDetail = message.result;
            if ('api_error_status' in message && typeof message.api_error_status === 'number') {
              apiErrorStatus = message.api_error_status;
            }
            typedErrorSeen = true;
          }
        } else {
          stop = 'api_error';
          apiErrorDetail = message.errors.join('; ');
          typedErrorSeen = true;
        }
      }
      if (state.fatal) break;
      if (state.captured) { stop = 'terminal'; break; }
      if (costUsd > input.budgetUsd) { stop = 'budget'; break; }
    }
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    if (state.fatal) {
      // The tool handler recorded the machine death; it wins below.
    } else if (typedErrorSeen) {
      logger.info('diagnose: SDK threw after a typed result; keeping the typed classification', {
        stop, error: detail,
      });
    } else if (/^Claude Code returned an error result: Reached maximum number of turns/.test(detail)) {
      stop = 'turns_exhausted';
    } else {
      stop = 'api_error';
      apiErrorDetail = detail;
      const status = (error as { status?: unknown }).status;
      if (typeof status === 'number') apiErrorStatus = status;
      logger.warn('diagnose: SDK query failed', { error: apiErrorDetail, status: apiErrorStatus });
    }
  } finally {
    try { await q.return?.(); } catch { /* best-effort subprocess cleanup */ }
  }

  if (state.fatal) throw state.fatal;
  const terminalInput = state.captured ?? (stop === 'api_error' ? null : state.rejectedSubmission);
  if (terminalInput && stop !== 'api_error' && stop !== 'budget') stop = 'terminal';
  if (!terminalInput && input.classification && state.filesRead.size < input.classification.minFilesRead
      && (stop === 'no_tool_call' || stop === 'turns_exhausted')) stop = 'no_evidence';
  annotateActiveSpan({
    'agent.stop': stop,
    'agent.cost_usd': costUsd,
    'agent.files_read': state.filesRead.size,
    'agent.input_tokens': usage.input,
    'agent.output_tokens': usage.output,
    ...(apiErrorStatus === undefined ? {} : { 'agent.api_error_status': apiErrorStatus }),
    ...(apiErrorDetail === undefined
      ? {}
      : { 'agent.api_error_detail': apiErrorDetail.slice(0, 200) }),
  });
  return {
    terminalInput,
    stop,
    ...(apiErrorStatus === undefined ? {} : { apiErrorStatus }),
    ...(apiErrorDetail === undefined ? {} : { apiErrorDetail }),
    filesRead: [...state.filesRead],
    lastModelText,
    costUsd,
    usage,
  };
}
