import { MachineUnavailableError } from './harness/errors.js';
import { grepExclusionArgs } from './harness/traversal-exclusions.js';

const MAX_FILE_SIZE = 50_000;
const MAX_SEARCH_RESULTS = 50;
export const MAX_LIST_ENTRIES = 200;

function addLineNumbers(content: string): string {
  return content
    .split('\n')
    .map((line, i) => `${(i + 1).toString().padStart(4)} | ${line}`)
    .join('\n');
}

/**
 * A machine-unavailable failure must reach the job, not the model.
 *
 * `instanceof` against the class exported from harness/errors.js, never a name
 * check: a name is mutable and an unrelated error could impersonate it.
 * errors.js imports nothing from this module, so there is no cycle.
 */
function rethrowIfMachineGone(err: unknown): void {
  if (err instanceof MachineUnavailableError) throw err;
}

/**
 * Everything the read-only agent may do to a checkout, as raw data.
 *
 * Formatting deliberately lives in the callers below, not here: the host and
 * sandbox implementations must be interchangeable, and if each produced its own
 * formatting the model's view would change silently when we switch.
 */
export interface RepoReader {
  /** Whole file as text, already bounded by the implementation. */
  readFile(path: string): Promise<string>;
  /** Raw grep stdout. Empty string means no matches. */
  grep(args: string[]): Promise<string>;
  /**
   * Raw directory listing, one entry per line.
   *
   * `recursive` is part of the seam rather than fixed by the implementation
   * because the `list_files` tool schema exposes it to the model; a reader that
   * ignored it would silently change what the model sees, which is the exact
   * drift this seam exists to prevent.
   */
  list(path: string, recursive: boolean): Promise<string>;
  /**
   * Of `paths`, the subset that resolves to a regular file inside the checkout,
   * returned in the caller's own spelling.
   *
   * Batched and narrow on purpose. Citation grounding has to tell "this file is
   * not in the repository" from "this file is here but you never opened it",
   * and those are different messages to send back to the model. A general
   * command escape would answer it too, and would reopen the hole this seam
   * closes, so this asks exactly one question.
   */
  exists(paths: string[]): Promise<string[]>;
}

/** read_file tool: read a source file from the repo with line numbers. */
export async function executeReadFile(
  reader: RepoReader,
  input: Record<string, unknown>,
): Promise<string> {
  const filePath = input['path'];
  if (typeof filePath !== 'string' || filePath.length === 0) return 'Error: "path" parameter is required';
  try {
    const content = await reader.readFile(filePath);
    return content.length > MAX_FILE_SIZE
      ? `${addLineNumbers(content.slice(0, MAX_FILE_SIZE))}\n... [truncated at 50KB]`
      : addLineNumbers(content);
  } catch (err: unknown) {
    rethrowIfMachineGone(err);
    const msg = err instanceof Error ? err.message : String(err);
    if (/ENOENT|No such file|not found/i.test(msg)) return `Error: file not found: ${filePath}`;
    return `Error: reading file failed: ${msg}`;
  }
}

/** search tool: grep for patterns in the repo, excluding node_modules/.git/dist. */
export async function executeSearch(
  reader: RepoReader,
  input: Record<string, unknown>,
): Promise<string> {
  const pattern = input['pattern'];
  if (typeof pattern !== 'string' || pattern.length === 0) return 'Error: "pattern" parameter is required';
  const include = typeof input['include'] === 'string' ? input['include'] : undefined;

  // Build --include flags. Brace expansion (*.{ts,vue}) doesn't work without a
  // shell, so we pass multiple --include arguments for the default extensions.
  const defaultExtensions = ['*.ts', '*.tsx', '*.js', '*.jsx', '*.vue', '*.svelte', '*.json', '*.go', '*.py'];
  const includeArgs = include
    ? ['--include', include]
    : defaultExtensions.flatMap((ext) => ['--include', ext]);
  const args = [
    '-r', '-n', ...includeArgs,
    ...grepExclusionArgs(),
    '-m', '5', // max 5 matches per file
    '--', pattern, '.',
  ];

  try {
    const stdout = await reader.grep(args);
    const lines = stdout.split('\n').filter(Boolean);
    if (lines.length === 0) return 'No matches found.';
    return lines.length > MAX_SEARCH_RESULTS
      ? `${lines.slice(0, MAX_SEARCH_RESULTS).join('\n')}\n... [${lines.length - MAX_SEARCH_RESULTS} more results]`
      : lines.join('\n');
  } catch (err: unknown) {
    rethrowIfMachineGone(err);
    return `Error searching: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** list_files tool: list directory entries in the repo. */
export async function executeListFiles(
  reader: RepoReader,
  input: Record<string, unknown>,
): Promise<string> {
  const path = typeof input['path'] === 'string' ? input['path'] : '.';
  const recursive = input['recursive'] === true;
  try {
    return await reader.list(path, recursive);
  } catch (err: unknown) {
    rethrowIfMachineGone(err);
    return `Error listing files: ${err instanceof Error ? err.message : String(err)}`;
  }
}
