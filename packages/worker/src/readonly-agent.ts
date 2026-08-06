import type Anthropic from '@anthropic-ai/sdk';
import { createAnthropicClient } from './anthropic-client.js';
import { executeListFiles, executeReadFile, executeSearch } from './investigate-tools.js';
import { logger } from './logger.js';
import { traceSpan } from './tracing.js';

/** Read-only tools shared by the dossier agent and the adjudicator. */
export function readOnlyTools(): Anthropic.Tool[] {
  return [
    {
      name: 'read_file',
      description: 'Read a source file from the repository. Returns content with line numbers.',
      input_schema: {
        type: 'object' as const,
        properties: {
          path: { type: 'string', description: 'Relative path from repository root (e.g. "src/App.vue")' },
        },
        required: ['path'],
      },
    },
    {
      name: 'search',
      description:
        'Search for a pattern in the repository using grep. Returns matching lines with file paths and line numbers.',
      input_schema: {
        type: 'object' as const,
        properties: {
          pattern: { type: 'string', description: 'The search pattern (basic regex)' },
          include: {
            type: 'string',
            description: 'File glob to limit the search (e.g. "*.vue"). Defaults to common source extensions.',
          },
        },
        required: ['pattern'],
      },
    },
    {
      name: 'list_files',
      description: 'List files and directories in the repository.',
      input_schema: {
        type: 'object' as const,
        properties: {
          path: { type: 'string', description: 'Relative directory path. Defaults to root (".").' },
          recursive: { type: 'boolean', description: 'Include one level of subdirectories. Defaults to false.' },
        },
      },
    },
  ];
}

export interface ReadOnlyRunInput {
  apiKey: string;
  model: string;
  maxTurns: number;
  budgetUsd: number;
  pricing: { input: number; output: number; cacheWrite: number; cacheRead: number };
  systemPrompt: string;
  firstMessage: string;
  /** The tool that ends the run. Its raw input is returned. */
  terminalTool: Anthropic.Tool;
  repoPath: string;
  /** Prefixes trace span names, e.g. "dossier" gives "dossier.read_file". */
  spanPrefix: string;
}

export type ReadOnlyStop = 'terminal' | 'budget' | 'no_tool_call' | 'api_error' | 'turns_exhausted';

export interface ReadOnlyRunResult {
  /** Raw input of the terminal tool call, or null if the run never made one. */
  terminalInput: Record<string, unknown> | null;
  stop: ReadOnlyStop;
  filesRead: string[];
  lastModelText: string;
  turns: number;
  costUsd: number;
}

/** Mark the last user message for prompt caching, clearing any earlier marker. */
function markLastUserMessageForCaching(messages: Anthropic.MessageParam[]): void {
  for (const message of messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if ('cache_control' in block) {
        delete (block as unknown as Record<string, unknown>)['cache_control'];
      }
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== 'user') continue;
    if (typeof message.content === 'string') {
      message.content = [
        { type: 'text' as const, text: message.content, cache_control: { type: 'ephemeral' as const } },
      ];
    } else if (Array.isArray(message.content) && message.content.length > 0) {
      const last = message.content[message.content.length - 1]!;
      (last as unknown as Record<string, unknown>)['cache_control'] = { type: 'ephemeral' as const };
    }
    return;
  }
}

/**
 * A bounded read-only tool loop. Both investigation agents use it so the budget
 * discipline, prompt caching and tracing stay identical between them.
 *
 * Every exit that is not a terminal tool call is an execution failure, and the
 * caller must treat it as one. Returning a partial answer as if it were a
 * finding is what let budget exhaustion masquerade as `fixable: true`.
 */
export async function runReadOnlyAgent(input: ReadOnlyRunInput): Promise<ReadOnlyRunResult> {
  const client = createAnthropicClient(input.apiKey);
  const tools = [...readOnlyTools(), input.terminalTool];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const filesRead: string[] = [];
  let lastModelText = '';
  let costUsd = 0;

  const systemMessages: Anthropic.TextBlockParam[] = [
    { type: 'text', text: input.systemPrompt, cache_control: { type: 'ephemeral' } },
  ];
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: input.firstMessage }];

  for (let turn = 0; turn < input.maxTurns; turn++) {
    markLastUserMessageForCaching(messages);

    const remaining = input.maxTurns - turn;
    if (remaining <= 2 && turn > 0) {
      const last = messages[messages.length - 1]!;
      if (last.role === 'user' && Array.isArray(last.content)) {
        last.content.push({
          type: 'text' as const,
          text:
            `You have ${remaining} turn(s) remaining. Call ${input.terminalTool.name} now with what the ` +
            'evidence you have already gathered supports. Do not read more files.',
        });
      }
    }

    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: input.model,
        max_tokens: 4096,
        system: systemMessages,
        messages,
        tools,
        ...(turn === input.maxTurns - 1
          ? { tool_choice: { type: 'tool' as const, name: input.terminalTool.name } }
          : {}),
      });
    } catch (error: unknown) {
      logger.warn(`${input.spanPrefix}: model call failed`, {
        error: error instanceof Error ? error.message : String(error),
        turn,
      });
      return { terminalInput: null, stop: 'api_error', filesRead, lastModelText, turns: turn + 1, costUsd };
    }

    usage.input += response.usage.input_tokens;
    usage.output += response.usage.output_tokens;
    usage.cacheRead += response.usage.cache_read_input_tokens ?? 0;
    usage.cacheWrite += response.usage.cache_creation_input_tokens ?? 0;
    costUsd =
      (usage.input / 1_000_000) * input.pricing.input +
      (usage.output / 1_000_000) * input.pricing.output +
      (usage.cacheWrite / 1_000_000) * input.pricing.cacheWrite +
      (usage.cacheRead / 1_000_000) * input.pricing.cacheRead;

    // Parse before the budget check: this response is already paid for, so
    // discarding it when it carries the answer wastes the spend and the answer.
    const toolCalls: { id: string; name: string; input: Record<string, unknown> }[] = [];
    for (const block of response.content) {
      if (block.type === 'text') lastModelText = block.text;
      if (block.type === 'tool_use') {
        toolCalls.push({ id: block.id, name: block.name, input: block.input as Record<string, unknown> });
      }
    }

    const terminal = toolCalls.find((call) => call.name === input.terminalTool.name);
    if (!terminal && costUsd > input.budgetUsd) {
      logger.warn(`${input.spanPrefix}: budget exceeded`, { cost: costUsd, budget: input.budgetUsd, turn });
      return { terminalInput: null, stop: 'budget', filesRead, lastModelText, turns: turn + 1, costUsd };
    }

    messages.push({ role: 'assistant', content: response.content });

    if (toolCalls.length === 0) {
      logger.warn(`${input.spanPrefix}: ended without calling ${input.terminalTool.name}`);
      return { terminalInput: null, stop: 'no_tool_call', filesRead, lastModelText, turns: turn + 1, costUsd };
    }

    if (terminal) {
      return {
        terminalInput: terminal.input,
        stop: 'terminal',
        filesRead,
        lastModelText,
        turns: turn + 1,
        costUsd,
      };
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const call of toolCalls) {
      const attrs: Record<string, string | number | boolean> = {
        'tool.name': call.name,
        [`${input.spanPrefix}.turn`]: turn,
      };
      if (typeof call.input['path'] === 'string') attrs['tool.file_path'] = call.input['path'];
      if (typeof call.input['pattern'] === 'string') attrs['tool.pattern'] = call.input['pattern'];

      const output = await traceSpan(`${input.spanPrefix}.${call.name}`, attrs, async () => {
        switch (call.name) {
          case 'read_file': {
            const path = call.input['path'] as string | undefined;
            const content = await executeReadFile(input.repoPath, call.input);
            if (path && !content.startsWith('Error:')) filesRead.push(path);
            return content;
          }
          case 'search':
            return executeSearch(input.repoPath, call.input);
          case 'list_files':
            return executeListFiles(input.repoPath, call.input);
          default:
            return `Error: Unknown tool "${call.name}"`;
        }
      });
      results.push({ type: 'tool_result', tool_use_id: call.id, content: output });
    }
    messages.push({ role: 'user', content: results });
  }

  return { terminalInput: null, stop: 'turns_exhausted', filesRead, lastModelText, turns: input.maxTurns, costUsd };
}
