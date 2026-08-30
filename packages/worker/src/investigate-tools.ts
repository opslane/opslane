import { execFile } from 'node:child_process';
import { open, readdir } from 'node:fs/promises';
import { normalize, resolve } from 'node:path';
import { promisify } from 'node:util';
import { MachineUnavailableError } from './harness/errors.js';
import { grepExclusionArgs, isExcludedTraversalDirectory } from './harness/traversal-exclusions.js';

const execFileAsync = promisify(execFile);

const MAX_FILE_SIZE = 50_000;
const MAX_SEARCH_RESULTS = 50;
const MAX_LIST_ENTRIES = 200;

/** Validate and resolve a path, blocking traversal outside repoPath. */
export function safePath(repoPath: string, requested: string): string | null {
  const resolved = resolve(repoPath, requested);
  // `resolve` removes a trailing separator. Keeping it here made the prefix
  // check compare against `repo//`, rejecting every valid child path when a
  // caller supplied a repository URL-derived path ending in `/`.
  const normalizedRepo = resolve(normalize(repoPath));
  if (!resolved.startsWith(normalizedRepo + '/') && resolved !== normalizedRepo) {
    return null;
  }
  return resolved;
}

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
}

/** A `RepoReader` over a checkout on this host's filesystem. */
export function createHostReader(repoPath: string): RepoReader {
  const contained = (requested: string): string => {
    const resolved = safePath(repoPath, requested);
    if (!resolved) throw new Error('path traversal blocked — path must be within the repository');
    return resolved;
  };

  return {
    readFile: async (filePath: string): Promise<string> => {
      // Read a bounded window rather than the whole file, because the model picks
      // the path: reading first and slicing to 50KB afterwards decoded a minified
      // vendor bundle or a lockfile into a JS string in full — potentially
      // hundreds of megabytes — inside the process that also runs sandbox and PR
      // work, to produce the same 50KB of output.
      const handle = await open(contained(filePath), 'r');
      try {
        const buffer = Buffer.alloc(MAX_FILE_SIZE + 1);
        const { bytesRead } = await handle.read(buffer, 0, MAX_FILE_SIZE + 1, 0);
        return buffer.subarray(0, bytesRead).toString('utf-8');
      } finally {
        await handle.close();
      }
    },

    grep: async (args: string[]): Promise<string> => {
      try {
        return (
          await execFileAsync('grep', args, { cwd: repoPath, maxBuffer: 512 * 1024, timeout: 10_000 })
        ).stdout;
      } catch (err: unknown) {
        // grep exits 1 when there are no matches, and execFileAsync rejects on
        // any non-zero code. That is an empty result, not a failure.
        if (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 1) {
          return String((err as { stdout?: string }).stdout ?? '');
        }
        throw err;
      }
    },

    list: async (dirPath: string, recursive: boolean): Promise<string> => {
      const resolved = contained(dirPath);
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
    },
  };
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
