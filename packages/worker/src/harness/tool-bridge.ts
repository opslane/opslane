import type { ToolDefinition, AgentState } from './types.js';
import type { SandboxRuntime } from './sandbox-runtime.js';
import { grepExclusionArgs } from './traversal-exclusions.js';
import type { Platform } from '../platform.js';
import { assertWritableSandboxPath, diffTargets, WriteOutsideRepoError } from '../repo-paths.js';

/** Where the repository is checked out inside the fix sandbox. */
const SANDBOX_REPO_PATH = '/home/user/repo';

/** Max characters per tool output to prevent context overflow. */
const MAX_OUTPUT_CHARS = 12_000;

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Truncate tool output to stay within context budget. */
function cap(output: string, limit = MAX_OUTPUT_CHARS): string {
  if (output.length <= limit) return output;
  const half = Math.max(Math.floor(limit / 2) - 50, 0);
  const omitted = output.length - limit;
  if (half === 0) return output.slice(0, limit) + `\n\n... [${omitted} chars omitted]`;
  return output.slice(0, half) + `\n\n... [${omitted} chars omitted] ...\n\n` + output.slice(-half);
}

/**
 * The three tools that write are gated on the repository clone: a write must
 * land inside it.
 *
 * `bash` is deliberately NOT gated. It can write anywhere and no tool-level
 * check covers it; its containment is the E2B sandbox, not this gate.
 */
export function createToolBridge(
  sandbox: SandboxRuntime,
  state: AgentState,
  platform: Platform = 'javascript',
): ToolDefinition[] {
  /** Authorize a path immediately before writing it, and write through what this returns. */
  const gate = (cited: string): string => assertWritableSandboxPath(SANDBOX_REPO_PATH, cited);

  /**
   * Run the gate and hand a refusal back to the model as text. A refusal is an
   * answer the agent can act on; anything else is a real fault and must throw.
   */
  const gated = async (run: () => Promise<string>): Promise<string> => {
    try {
      return await run();
    } catch (error: unknown) {
      if (error instanceof WriteOutsideRepoError) return error.message;
      throw error;
    }
  };

  return [
    {
      name: 'read',
      description: 'Read a file from the repository. Returns the full file content.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute path to the file' } },
        required: ['path'],
      },
      execute: async (input) => {
        return cap(await sandbox.files.read(input.path as string));
      },
    },
    {
      name: 'write',
      description: 'Write content to a file. Creates the file if it does not exist, overwrites if it does.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file' },
          content: { type: 'string', description: 'Full file content to write' },
        },
        required: ['path', 'content'],
      },
      execute: async (input) => gated(async () => {
        // Write through the resolved path, not the string the model supplied.
        const target = gate(input.path as string);
        await sandbox.files.write(target, input.content as string);
        return `Written to ${target}`;
      }),
    },
    {
      name: 'edit',
      description: 'Find and replace a string in a file. The old_string must appear exactly once.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file' },
          old_string: { type: 'string', description: 'The exact string to find (must be unique in the file)' },
          new_string: { type: 'string', description: 'The replacement string' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
      execute: async (input) => gated(async () => {
        const path = gate(input.path as string);
        const oldStr = input.old_string as string;
        const newStr = input.new_string as string;
        const content = await sandbox.files.read(path);
        const occurrences = content.split(oldStr).length - 1;
        if (occurrences === 0) return `Error: old_string not found in ${path}`;
        if (occurrences > 1) return `Error: old_string found ${occurrences} times in ${path}. Must be unique.`;
        const updated = content.replace(oldStr, () => newStr);
        await sandbox.files.write(path, updated);
        return `Applied edit to ${path}`;
      }),
    },
    {
      name: 'bash',
      description: `Run a shell command in the sandbox. Use for git, ${platform === 'python' ? 'python, pip, pytest' : 'npm and test runners'}, etc.`,
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to execute' },
          timeout: { type: 'number', description: 'Timeout in ms (default: 120000)' },
        },
        required: ['command'],
      },
      execute: async (input) => {
        const timeout = (input.timeout as number) ?? 120_000;
        const result = await sandbox.commands.run(input.command as string, { timeoutMs: timeout });
        if (result.exitCode === 0) return cap(result.stdout || '(no output)');
        return cap([
          `Exit code: ${result.exitCode}`,
          result.stdout ? `stdout:\n${result.stdout}` : '',
          result.stderr ? `stderr:\n${result.stderr}` : '',
        ].filter(Boolean).join('\n'));
      },
    },
    {
      name: 'read_many',
      description: 'Read multiple files at once. Returns a JSON object mapping path to content.',
      inputSchema: {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' }, description: 'Array of absolute file paths to read' },
        },
        required: ['paths'],
      },
      execute: async (input) => {
        const paths = input.paths as string[];
        const perFile = Math.floor(MAX_OUTPUT_CHARS / Math.max(paths.length, 1));
        const results: Record<string, string> = {};
        await Promise.all(paths.map(async (p) => {
          try { results[p] = cap(await sandbox.files.read(p), perFile); }
          catch { results[p] = `Error: could not read ${p}`; }
        }));
        return cap(JSON.stringify(results, null, 2));
      },
    },
    {
      name: 'search',
      description: 'Search for a pattern in files using grep. Returns matching lines with file paths and line numbers.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search for' },
          path: { type: 'string', description: 'Directory or file to search in (default: current directory)' },
          include: { type: 'string', description: 'Glob pattern to filter files (e.g., "*.ts")' },
        },
        required: ['pattern'],
      },
      execute: async (input) => {
        const pattern = input.pattern as string;
        const path = (input.path as string) || '.';
        const include = input.include ? `--include=${shellEscape(input.include as string)}` : '';
        const exclusions = grepExclusionArgs().map(shellEscape).join(' ');
        const cmd = `grep -rn ${exclusions} ${include} ${shellEscape(pattern)} ${shellEscape(path)} 2>/dev/null | head -100`;
        const result = await sandbox.commands.run(cmd, { timeoutMs: 30_000 });
        return cap(result.stdout || 'No matches found.');
      },
    },
    {
      name: 'patch',
      description: 'Apply a unified diff patch to the codebase.',
      inputSchema: {
        type: 'object',
        properties: { diff: { type: 'string', description: 'The unified diff to apply' } },
        required: ['diff'],
      },
      execute: async (input) => gated(async () => {
        const diff = input.diff as string;
        // A patch names its own targets, so the gate reads them out of the diff
        // headers. `diffTargets` returns them as `patch -p1` will write them,
        // with the one leading component already stripped, so what is authorized
        // is what lands. An unparseable diff, or one whose headers are not in the
        // `a/`+`b/` form that makes the strip unambiguous, is refused rather than
        // applied blind: `patch -p1` would otherwise write wherever they pointed.
        const targets = diffTargets(diff);
        if (targets.length === 0) {
          return 'Refusing to apply a patch whose target files could not be read from its headers. ' +
            'Use a unified diff with the standard a/ and b/ path prefixes (as `git diff` produces).';
        }
        for (const target of targets) gate(target);
        const patchFile = `/tmp/agent-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`;
        await sandbox.files.write(patchFile, diff);
        const result = await sandbox.commands.run(`cd /home/user/repo && patch -p1 < ${patchFile}`, { timeoutMs: 30_000 });
        if (result.exitCode === 0) return `Patch applied successfully.\n${result.stdout}`;
        return `Patch failed (exit ${result.exitCode}):\n${result.stderr}\n${result.stdout}`;
      }),
    },
    {
      name: 'submit_diagnosis',
      description:
        'Call this when you cannot fix the error in this repository. Report what you found ' +
        'after reading the code. Do not choose what happens next.',
      inputSchema: {
        type: 'object',
        properties: {
          one_line_description: { type: 'string', description: 'What caused the error, in under 30 words' },
          why_chain: { type: 'array', items: { type: 'string' }, description: 'Ordered why-statements, each under 15 words' },
          reproduction_steps: { type: 'array', items: { type: 'string' }, description: 'Steps that reproduce it, each under 15 words' },
          cause_kind: {
            type: 'string',
            enum: ['local_code', 'external_system', 'data_or_input', 'configuration', 'unknown'],
            description:
              'Where the cause lives. external_system or data_or_input mean it is not code we hold, ' +
              'which makes this a conclusion rather than a failure.',
          },
          cause_location: { type: 'string', description: 'path/to/file.ts:42, or the external system' },
          change_counterfactual: { type: 'string', description: 'What change here would remove the cause, or why none would' },
          unknowns: { type: 'array', items: { type: 'string' }, description: 'What you could not establish' },
        },
        required: [
          'one_line_description',
          'why_chain',
          'reproduction_steps',
          'cause_kind',
          'cause_location',
          'change_counterfactual',
        ],
      },
      execute: async (input) => {
        state.gaveUp = true;
        state.submittedDiagnosis = input;
        return 'Acknowledged. Ending agent loop.';
      },
    },
    {
      name: 'declare_failing_test',
      description: 'Declare the regression test that proves this bug: it must FAIL on the unmodified base commit and PASS with your fix. The harness will verify both mechanically; a test that passes on base voids the attempt.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          test_files: {
            type: 'array', minItems: 1, maxItems: 5, items: { type: 'string' },
            description: 'Repo-relative paths of every file the test needs that you added or modified.',
          },
          identifier: { type: 'string', maxLength: 300 },
          expected_assertion: { type: 'string', maxLength: 500 },
        },
        required: ['test_files', 'identifier', 'expected_assertion'],
      },
      execute: async (input) => {
        state.declaredTest = {
          testFiles: [...(input.test_files as string[])],
          identifier: input.identifier as string,
          expectedAssertion: input.expected_assertion as string,
        };
        state.reproductionImpossibleReason = undefined;
        return 'Failing-test declaration recorded for harness verification.';
      },
    },
    {
      name: 'declare_reproduction_impossible',
      description: 'Declare that a failing regression test cannot be written, with the concrete reason. This caps the attempt at tier "checked".',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { reason: { type: 'string', maxLength: 600 } },
        required: ['reason'],
      },
      execute: async (input) => {
        state.declaredTest = undefined;
        state.reproductionImpossibleReason = input.reason as string;
        return 'Reproduction-impossible declaration recorded for harness verification.';
      },
    },
  ];
}
