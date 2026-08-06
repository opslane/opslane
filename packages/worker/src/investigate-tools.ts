import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { normalize, resolve } from 'node:path';
import { promisify } from 'node:util';
import { grepExclusionArgs, isExcludedTraversalDirectory } from './harness/traversal-exclusions.js';

const execFileAsync = promisify(execFile);

const MAX_FILE_SIZE = 50_000;
const MAX_SEARCH_RESULTS = 50;
const MAX_LIST_ENTRIES = 200;

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
