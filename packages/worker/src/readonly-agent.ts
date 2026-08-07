import type Anthropic from '@anthropic-ai/sdk';
import { createAnthropicClient } from './anthropic-client.js';
import { executeListFiles, executeReadFile, executeSearch } from './investigate-tools.js';
import { logger } from './logger.js';
import { traceSpan } from './tracing.js';

/** The read-only tools the investigation agent may call. */
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
}

/** Prefixes trace span and log names, e.g. "diagnose.read_file". */
const SPAN_PREFIX = 'diagnose';

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
  /** The model ran out of output tokens mid-answer. See the stop_reason check below. */
  | 'truncated';

export interface ReadOnlyRunResult {
  /** Raw input of the terminal tool call, or null if the run never made one. */
  terminalInput: Record<string, unknown> | null;
  stop: ReadOnlyStop;
  filesRead: string[];
  lastModelText: string;
  costUsd: number;
  /**
   * Token counts for the whole run, cache reads and writes separated.
   *
   * Surfaced rather than collapsed into `costUsd` because the cache-hit rate is
   * the number that says whether prompt caching is working at all, and a dollar
   * figure cannot answer that.
   */
  usage: TokenUsage;
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
 * A bounded read-only tool loop for the investigation agent, carrying the budget
 * discipline, prompt caching and tracing.
 *
 * Every exit that is not a terminal tool call is an execution failure, and the
 * caller must treat it as one. Returning a partial answer as if it were a
 * finding is what let budget exhaustion masquerade as `fixable: true`.
 */
export async function runReadOnlyAgent(input: ReadOnlyRunInput): Promise<ReadOnlyRunResult> {
  const client = createAnthropicClient(input.apiKey);
  const tools = [...readOnlyTools(), input.terminalTool];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  // A Set, because this is reported as coverage — `investigation.files_read`
  // and a `filesRead.length` in two log lines. Counting a re-read twice made a
  // run that thrashed on one file look broader than one that read three.
  const filesRead = new Set<string>();
  let lastModelText = '';
  let costUsd = 0;
  /** Whether the prose-instead-of-tool-call nudge has already been spent. */
  let nudged = false;

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
        // Sized for the terminal payload (reasoning, every candidate considered,
        // the rejections and the citations) with headroom, because on Sonnet 5
        // this ceiling covers thinking tokens as well as the response. At 4096 a
        // long adjudication could be cut off mid-tool-call, and the truncation
        // was invisible — see the stop_reason check below.
        max_tokens: 16000,
        system: systemMessages,
        messages,
        tools,
        ...(turn === input.maxTurns - 1
          ? { tool_choice: { type: 'tool' as const, name: input.terminalTool.name } }
          : {}),
      });
    } catch (error: unknown) {
      logger.warn(`${SPAN_PREFIX}: model call failed`, {
        error: error instanceof Error ? error.message : String(error),
        turn,
      });
      return { terminalInput: null, stop: 'api_error', filesRead: [...filesRead], lastModelText, costUsd, usage };
    }

    // A truncated turn is not a completed one. Nothing read `stop_reason`, so a
    // `submit_diagnosis` call cut off mid-argument was pushed into `toolCalls`
    // and returned as `terminalInput`; the run then looked successful and every
    // paid turn was thrown away downstream when parsing the partial JSON failed.
    // Failing here names the cause instead.
    if (response.stop_reason === 'max_tokens') {
      logger.warn(`${SPAN_PREFIX}: response hit the output token ceiling`, {
        turn,
        max_tokens: 16000,
      });
      usage.input += response.usage.input_tokens;
      usage.output += response.usage.output_tokens;
      usage.cacheRead += response.usage.cache_read_input_tokens ?? 0;
      usage.cacheWrite += response.usage.cache_creation_input_tokens ?? 0;
      return { terminalInput: null, stop: 'truncated', filesRead: [...filesRead], lastModelText, costUsd, usage };
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
      logger.warn(`${SPAN_PREFIX}: budget exceeded`, { cost: costUsd, budget: input.budgetUsd, turn });
      return { terminalInput: null, stop: 'budget', filesRead: [...filesRead], lastModelText, costUsd, usage };
    }

    messages.push({ role: 'assistant', content: response.content });

    if (toolCalls.length === 0) {
      // The model wrote its answer as prose instead of calling the tool. Returning
      // here threw away two correct diagnoses on a six-case run: the loop exited
      // before the last turn, which is the only place tool_choice forces the
      // terminal call, so the one mechanism built for this could never fire.
      //
      // Ask once, then give up. Asking twice would let a model that will never
      // call the tool burn the whole budget on prose.
      if (nudged) {
        logger.warn(`${SPAN_PREFIX}: ended without calling ${input.terminalTool.name}`, { turn });
        return { terminalInput: null, stop: 'no_tool_call', filesRead: [...filesRead], lastModelText, costUsd, usage };
      }
      nudged = true;
      messages.push({
        role: 'user',
        content: [
          {
            type: 'text' as const,
            text:
              `You answered in prose. Nothing is recorded until you call ${input.terminalTool.name}. ` +
              `Call it now with what you already established — do not read more files.`,
          },
        ],
      });
      continue;
    }

    if (terminal) {
      return { terminalInput: terminal.input, stop: 'terminal', filesRead: [...filesRead], lastModelText, costUsd, usage };
    }

    // The calls in a turn are independent I/O — a grep subprocess and disk
    // reads — so they run together. Promise.all preserves the order the model
    // asked in, which the tool_result blocks have to match.
    const executed = await Promise.all(
      toolCalls.map(async (call) => {
        const attrs: Record<string, string | number | boolean> = {
          'tool.name': call.name,
          [`${SPAN_PREFIX}.turn`]: turn,
        };
        if (typeof call.input['path'] === 'string') attrs['tool.file_path'] = call.input['path'];
        if (typeof call.input['pattern'] === 'string') attrs['tool.pattern'] = call.input['pattern'];

        return traceSpan(`${SPAN_PREFIX}.${call.name}`, attrs, async () => {
          switch (call.name) {
            case 'read_file': {
              const path = call.input['path'] as string | undefined;
              const content = await executeReadFile(input.repoPath, call.input);
              const read = path && !content.startsWith('Error:') ? path : null;
              return { id: call.id, output: content, read };
            }
            case 'search':
              return { id: call.id, output: await executeSearch(input.repoPath, call.input), read: null };
            case 'list_files':
              return { id: call.id, output: await executeListFiles(input.repoPath, call.input), read: null };
            default:
              return { id: call.id, output: `Error: Unknown tool "${call.name}"`, read: null };
          }
        });
      }),
    );

    // Recorded after the fan-out, in the order the model asked, so concurrency
    // cannot reorder what the caller reports as the files the agent opened.
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const { id, output, read } of executed) {
      if (read) filesRead.add(read);
      results.push({ type: 'tool_result', tool_use_id: id, content: output });
    }
    messages.push({ role: 'user', content: results });
  }

  return { terminalInput: null, stop: 'turns_exhausted', filesRead: [...filesRead], lastModelText, costUsd, usage };
}
