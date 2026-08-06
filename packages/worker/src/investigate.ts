import type Anthropic from '@anthropic-ai/sdk';
import type { Diagnosis, DiagnosisOutcome } from '@opslane/shared';
import { createAnthropicClient } from './anthropic-client.js';
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, normalize, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { extractStackTraceFiles } from './harness/stack-trace-utils.js';
import type { Platform } from './platform.js';
import type { RuntimeInfo } from './runtime-info.js';
import { logger } from './logger.js';
import { traceSpan } from './tracing.js';
import type { TriageResult } from './agent-fix.js';
import { grepExclusionArgs, isExcludedTraversalDirectory } from './harness/traversal-exclusions.js';
import { deriveOutcome } from './classify.js';
import { parseDiagnosis, submitDiagnosisTool } from './diagnosis-schema.js';
import type { FixSurface } from './fix-surface.js';

const execFileAsync = promisify(execFile);

const INVESTIGATION_MODEL = process.env['INVESTIGATION_MODEL'] ?? 'claude-sonnet-4-6';
const MAX_TURNS = Number(process.env['INVESTIGATION_MAX_TURNS'] ?? 10);
const DEFAULT_BUDGET_USD = 0.15;
const MAX_FILE_SIZE = 50_000;
const MAX_SEARCH_RESULTS = 50;
const MAX_LIST_ENTRIES = 200;
const MAX_ERROR_MESSAGE = 500;
const MAX_STACK_TRACE = 3000;

const MODEL_PRICING: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  'claude-sonnet-4-6': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 },
};
const DEFAULT_PRICING = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 };

/** Validate and resolve a path, blocking traversal outside repoPath. */
export function safePath(repoPath: string, requested: string): string | null {
  const resolved = resolve(repoPath, requested);
  const normalizedRepo = normalize(repoPath);
  if (!resolved.startsWith(normalizedRepo + '/') && resolved !== normalizedRepo) {
    return null;
  }
  return resolved;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '... [truncated]' : s;
}

function runtimeLabel(value: string): string {
  return value.replace(/[^A-Za-z0-9._+\- ]/g, '').trim().slice(0, 64) || 'unknown';
}

function addLineNumbers(content: string): string {
  return content
    .split('\n')
    .map((line, i) => `${(i + 1).toString().padStart(4)} | ${line}`)
    .join('\n');
}

/** read_file tool: read a source file from the repo with line numbers. */
export async function executeReadFile(
  repoPath: string,
  input: Record<string, unknown>,
): Promise<string> {
  const filePath = input['path'] as string | undefined;
  if (!filePath) return 'Error: "path" parameter is required';

  const resolved = safePath(repoPath, filePath);
  if (!resolved) return 'Error: path traversal blocked — path must be within the repository';

  try {
    const content = await readFile(resolved, 'utf-8');
    if (content.length > MAX_FILE_SIZE) {
      return addLineNumbers(content.slice(0, MAX_FILE_SIZE)) + '\n... [truncated at 50KB]';
    }
    return addLineNumbers(content);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ENOENT')) return `Error: file not found: ${filePath}`;
    return `Error: reading file failed: ${msg}`;
  }
}

/** search tool: grep for patterns in the repo, excluding node_modules/.git/dist. */
export async function executeSearch(
  repoPath: string,
  input: Record<string, unknown>,
): Promise<string> {
  const pattern = input['pattern'] as string | undefined;
  if (!pattern) return 'Error: "pattern" parameter is required';

  const include = input['include'] as string | undefined;

  // Build --include flags. Brace expansion (*.{ts,vue}) doesn't work with execFile (no shell),
  // so we pass multiple --include arguments when using the default extensions.
  const defaultExtensions = ['*.ts', '*.tsx', '*.js', '*.jsx', '*.vue', '*.svelte', '*.json', '*.go', '*.py'];
  const includeArgs = include
    ? ['--include', include]
    : defaultExtensions.flatMap(ext => ['--include', ext]);

  const args = [
    '-r', '-n', ...includeArgs,
    ...grepExclusionArgs(),
    '-m', '5', // max 5 matches per file
  ];

  args.push('--', pattern, '.');

  try {
    const { stdout } = await execFileAsync('grep', args, {
      cwd: repoPath,
      maxBuffer: 512 * 1024,
      timeout: 10_000,
    });

    const lines = stdout.split('\n').filter(Boolean);
    if (lines.length > MAX_SEARCH_RESULTS) {
      return lines.slice(0, MAX_SEARCH_RESULTS).join('\n') + `\n... [${lines.length - MAX_SEARCH_RESULTS} more results]`;
    }
    if (lines.length === 0) return 'No matches found.';
    return lines.join('\n');
  } catch (err: unknown) {
    // grep exits 1 when no matches found — that's not an error
    if (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 1) {
      return 'No matches found.';
    }
    const msg = err instanceof Error ? err.message : String(err);
    return `Error searching: ${msg}`;
  }
}

/** list_files tool: list directory entries in the repo. */
export async function executeListFiles(
  repoPath: string,
  input: Record<string, unknown>,
): Promise<string> {
  const dirPath = (input['path'] as string | undefined) ?? '.';
  const recursive = input['recursive'] === true;

  const resolved = safePath(repoPath, dirPath);
  if (!resolved) return 'Error: path traversal blocked — path must be within the repository';

  try {
    const entries = await readdir(resolved, { withFileTypes: true });
    const results: string[] = [];

    for (const entry of entries) {
      if (isExcludedTraversalDirectory(entry.name)) continue;
      if (results.length >= MAX_LIST_ENTRIES) {
        results.push(`... [truncated at ${MAX_LIST_ENTRIES} entries]`);
        break;
      }
      const suffix = entry.isDirectory() ? '/' : '';
      results.push(`${dirPath === '.' ? '' : dirPath + '/'}${entry.name}${suffix}`);

      if (recursive && entry.isDirectory() && results.length < MAX_LIST_ENTRIES) {
        try {
          const subEntries = await readdir(resolve(resolved, entry.name), { withFileTypes: true });
          for (const sub of subEntries) {
            if (isExcludedTraversalDirectory(sub.name)) continue;
            if (results.length >= MAX_LIST_ENTRIES) break;
            const subSuffix = sub.isDirectory() ? '/' : '';
            results.push(`${dirPath === '.' ? '' : dirPath + '/'}${entry.name}/${sub.name}${subSuffix}`);
          }
        } catch { /* skip unreadable subdirs */ }
      }
    }

    if (results.length === 0) return 'Empty directory.';
    return results.join('\n');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ENOENT')) return `Error: directory not found: ${dirPath}`;
    if (msg.includes('ENOTDIR')) return `Error: not a directory: ${dirPath}`;
    return `Error listing directory: ${msg}`;
  }
}

function toolsFor(): Anthropic.Tool[] {
  return [
  {
    name: 'read_file',
    description: 'Read a source file from the repository. Returns content with line numbers.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Relative path from repository root (e.g. "src/App.vue")',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'search',
    description: 'Search for a pattern in the repository using grep. Returns matching lines with file paths and line numbers.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: {
          type: 'string',
          description: 'The search pattern (basic regex)',
        },
        include: {
          type: 'string',
          description: 'File glob pattern to limit search (e.g. "*.vue", "*.ts"). Defaults to common source extensions.',
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
        path: {
          type: 'string',
          description: 'Relative directory path from repository root. Defaults to root (".").',
        },
        recursive: {
          type: 'boolean',
          description: 'If true, include one level of subdirectory contents. Defaults to false.',
        },
      },
    },
  },
    submitDiagnosisTool(),
  ];
}

function buildInvestigationPrompt(
  input: {
    errorType: string;
    title: string;
    errorMessage: string;
    stackTrace: string;
    resolvedStackTrace: unknown;
    breadcrumbs: string;
    platform?: Platform;
    customerRuntime?: RuntimeInfo | null;
  },
): string {
  const platform = input.platform ?? 'javascript';
  const python = platform === 'python';
  const resolvedSection = input.resolvedStackTrace
    ? `\n\nResolved Stack Trace (source-mapped):\n<untrusted_data>\n${truncate(JSON.stringify(input.resolvedStackTrace), MAX_STACK_TRACE)}\n</untrusted_data>`
    : '';

  return `You are investigating a production ${python ? 'Python error from a CPython traceback' : 'JavaScript/browser error'}.

You have read-only access to the repository via tools.

## Your Task
Find the ROOT CAUSE of this error. Do not propose fixes, only identify why the error is happening.

- Use your tools to read the relevant code.
- Ask "why" repeatedly until you reach the true cause, not just the symptom.
- Reading is not fixing. Open code anywhere in the repository that helps you explain what happened.
- Report where the cause lives. Do not decide whether we are able to fix it.

${python
    ? 'IMPORTANT: Follow the traceback newest-first and use exact repository paths. Python runs do not use browser source maps.'
    : 'IMPORTANT: If a "Resolved Stack Trace" section is present, use it — it contains source-mapped paths.'}

Customer runtime (untrusted metadata):
<untrusted_data>
${input.customerRuntime ? `${runtimeLabel(input.customerRuntime.name)} ${runtimeLabel(input.customerRuntime.version)}` : 'unknown'}
</untrusted_data>

## Error Details
Type: ${input.errorType}
Title: ${input.title}

Message:
<untrusted_data>
${truncate(input.errorMessage, MAX_ERROR_MESSAGE)}
</untrusted_data>

Stack Trace:
<untrusted_data>
${truncate(input.stackTrace, MAX_STACK_TRACE)}
</untrusted_data>${resolvedSection}

Breadcrumbs:
<untrusted_data>
${truncate(input.breadcrumbs ?? '[]', 1000)}
</untrusted_data>`;
}

/** Mark the last user message block with cache_control for prompt caching. */
function markLastUserMessageForCaching(messages: Anthropic.MessageParam[]): void {
  for (const msg of messages) {
    if (msg.role !== 'user' || typeof msg.content === 'string') continue;
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if ('cache_control' in block) {
        delete (block as unknown as Record<string, unknown>)['cache_control'];
      }
    }
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    if (typeof msg.content === 'string') {
      msg.content = [{
        type: 'text' as const,
        text: msg.content,
        cache_control: { type: 'ephemeral' as const },
      }];
    } else if (Array.isArray(msg.content) && msg.content.length > 0) {
      const lastBlock = msg.content[msg.content.length - 1];
      (lastBlock as unknown as Record<string, unknown>)['cache_control'] = { type: 'ephemeral' };
    }
    break;
  }
}

export interface InvestigateInput {
  platform?: Platform;
  customerRuntime?: RuntimeInfo | null;
  errorType: string;
  title: string;
  errorMessage: string;
  stackTrace: string;
  resolvedStackTrace: unknown;
  breadcrumbs: string;
}

export interface InvestigationResult extends TriageResult {
  diagnosis: Diagnosis | null;
  outcome: DiagnosisOutcome;
  decisionReason: string;
  /** Files explicitly opened via read_file tool (not search hits). May contain duplicates if re-read. */
  filesRead: string[];
  /** Last model text block before diagnosis — best-effort diagnostic, not comprehensive. */
  findings: string;
}

/**
 * Codebase-aware investigation: multi-turn Sonnet loop with read-only filesystem
 * tools against the local repo clone. Replaces blind triage for production pipeline.
 *
 * Execution failures produce needs_more_context; only a derived code_fix is fixable.
 */
export async function investigateError(
  apiKey: string,
  input: InvestigateInput,
  repoPath: string,
  surface: FixSurface,
): Promise<InvestigationResult> {
  const client = createAnthropicClient(apiKey);
  const pricing = MODEL_PRICING[INVESTIGATION_MODEL] ?? DEFAULT_PRICING;
  const budgetUsd = Number(process.env['INVESTIGATION_BUDGET_USD'] ?? DEFAULT_BUDGET_USD);
  const tokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const filesRead: string[] = [];
  let lastModelText = '';

  const systemPrompt = buildInvestigationPrompt(input);
  const tools = toolsFor();
  const systemMessages: Anthropic.TextBlockParam[] = [{
    type: 'text',
    text: systemPrompt,
    cache_control: { type: 'ephemeral' },
  }];

  // Seed with file hints from stack trace to guide first tool call
  const stackFiles = extractStackTraceFiles(input.stackTrace, input.platform);
  const fileHints = stackFiles.length > 0
    ? `\n\nFiles from the stack trace to start with: ${stackFiles.slice(0, 5).join(', ')}`
    : '';

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: `Investigate this error and submit your diagnosis using submit_diagnosis.${fileHints}` },
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    markLastUserMessageForCaching(messages);

    // Turn-budget pressure: warn on penultimate turns, force on final turn
    const remaining = MAX_TURNS - turn;
    if (remaining <= 2 && turn > 0) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg.role === 'user' && Array.isArray(lastMsg.content)) {
        lastMsg.content.push({
          type: 'text' as const,
          text: `You have ${remaining} turn(s) remaining. You MUST call submit_diagnosis now with the best diagnosis supported by the evidence gathered so far. Do not read more files.`,
        });
      }
    }

    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: INVESTIGATION_MODEL,
        max_tokens: 4096,
        system: systemMessages,
        messages,
        tools,
        ...(turn === MAX_TURNS - 1 ? { tool_choice: { type: 'tool' as const, name: 'submit_diagnosis' } } : {}),
      });
    } catch (err: unknown) {
      logger.warn('Investigation API call failed', {
        error: err instanceof Error ? err.message : String(err),
        turn,
      });
      return {
        fixable: false,
        confidence: 'low',
        reason: 'Investigation API call failed',
        diagnosis: null,
        outcome: 'needs_more_context',
        decisionReason: 'Investigation API call failed',
        filesRead,
        findings: lastModelText,
      };
    }

    tokenUsage.input += response.usage.input_tokens;
    tokenUsage.output += response.usage.output_tokens;
    tokenUsage.cacheRead += response.usage.cache_read_input_tokens ?? 0;
    tokenUsage.cacheWrite += response.usage.cache_creation_input_tokens ?? 0;

    // Budget check
    const cost =
      (tokenUsage.input / 1_000_000) * pricing.input +
      (tokenUsage.output / 1_000_000) * pricing.output +
      (tokenUsage.cacheWrite / 1_000_000) * pricing.cacheWrite +
      (tokenUsage.cacheRead / 1_000_000) * pricing.cacheRead;

    // Process response blocks BEFORE the budget check. This response is already
    // paid for; if it carries the diagnosis, discarding it wastes the spend
    // AND throws away the answer.
    const toolCalls: { id: string; name: string; input: Record<string, unknown> }[] = [];
    for (const block of response.content) {
      if (block.type === 'text') {
        lastModelText = block.text;
      }
      if (block.type === 'tool_use') {
        toolCalls.push({ id: block.id, name: block.name, input: block.input as Record<string, unknown> });
      }
    }

    // Budget check. Fails CLOSED: exhaustion is an execution failure, not a
    // finding, so it must not hand the fix agent a `fixable: true` it never
    // earned. Skipped when this response already contains the diagnosis.
    const hasDiagnosis = toolCalls.some((toolCall) => toolCall.name === 'submit_diagnosis');
    if (cost > budgetUsd && !hasDiagnosis) {
      logger.warn('Investigation budget exceeded', { cost, budget: budgetUsd, turn });
      return {
        fixable: false,
        confidence: 'low',
        reason: 'Investigation budget exceeded',
        diagnosis: null,
        outcome: 'needs_more_context',
        decisionReason: 'Investigation budget exceeded',
        filesRead,
        findings: lastModelText,
      };
    }

    messages.push({ role: 'assistant', content: response.content });

    // No tool calls means the model ended without a usable diagnosis.
    if (toolCalls.length === 0) {
      logger.warn('Investigation ended without submit_diagnosis call');
      return {
        fixable: false,
        confidence: 'low',
        reason: 'Investigation did not produce a diagnosis',
        diagnosis: null,
        outcome: 'needs_more_context',
        decisionReason: 'Investigation did not produce a diagnosis',
        filesRead,
        findings: lastModelText,
      };
    }

    // Execute tool calls
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tc of toolCalls) {
      if (tc.name === 'submit_diagnosis') {
        const diagnosis = parseDiagnosis(tc.input);
        const fileExists = (path: string): boolean => {
          try {
            return statSync(join(repoPath, path)).isFile();
          } catch {
            return false;
          }
        };
        const decision = deriveOutcome(diagnosis, surface, fileExists);
        return {
          fixable: decision.outcome === 'code_fix',
          confidence: decision.confidence,
          reason: decision.reason,
          diagnosis,
          outcome: decision.outcome,
          decisionReason: decision.reason,
          filesRead,
          findings: lastModelText,
        };
      }

      // Execute read-only tools
      let output: string;
      switch (tc.name) {
        case 'read_file': {
          const filePath = tc.input['path'] as string | undefined;
          output = await executeReadFile(repoPath, tc.input);
          if (filePath && !output.startsWith('Error:')) filesRead.push(filePath);
          break;
        }
        case 'search':
          output = await executeSearch(repoPath, tc.input);
          break;
        case 'list_files':
          output = await executeListFiles(repoPath, tc.input);
          break;
        default:
          output = `Error: Unknown tool "${tc.name}"`;
          break;
      }

      toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: output });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  // Max turns exhausted
  logger.warn('Investigation reached maximum turns', { maxTurns: MAX_TURNS });
  return {
    fixable: false,
    confidence: 'low',
    reason: 'Investigation did not produce a diagnosis',
    diagnosis: null,
    outcome: 'needs_more_context',
    decisionReason: 'Investigation did not produce a diagnosis',
    filesRead,
    findings: lastModelText,
  };
}
