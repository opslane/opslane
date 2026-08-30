import { execFile } from 'node:child_process';
import { open, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { MAX_LIST_ENTRIES, type RepoReader } from '../investigate-tools.js';
import { resolveDirInsideRepo, resolveInsideRepo } from '../repo-paths.js';
import { isExcludedTraversalDirectory } from './traversal-exclusions.js';

const execFileAsync = promisify(execFile);
const MAX_FILE_SIZE = 50_000;

/**
 * A `RepoReader` over a checkout on this host's filesystem.
 *
 * Exactly two callers may use it, and neither is a read-only job that was
 * isolated by this change:
 *
 * - the fix pipeline (`agent-fix.ts`), which needs a host checkout anyway
 *   because it applies a diff and pushes a branch;
 * - `product-context/job.ts`, which is a KNOWN GAP tracked separately:
 *   `discoverRepositoryRoutes` walks the whole checkout and reads up to 10,000
 *   files, which this three-method seam cannot express at a workable cost.
 *
 * Investigation, inquiry and friction read inside a per-run sandbox
 * (`readonly-sandbox.ts`) and must never import this.
 * `src/__tests__/readonly-isolation.test.ts` enforces that.
 *
 * It deliberately does not live in `investigate-tools.ts`, so that the module
 * the isolated jobs do import stays free of filesystem access.
 */
export function createHostReader(repoPath: string): RepoReader {
  /**
   * Where a requested path really is, or null if it is not in the repository.
   *
   * The check this replaced was lexical — `resolve` then `startsWith` — and a
   * lexical check cannot see a symlink. A checkout is untrusted input, so a
   * repository can ship `escape.ts -> /etc/passwd`: the requested path is
   * literally under the repository root, passes the prefix test, and the read
   * then follows the link off the checkout. Demonstrated against this reader,
   * which returned the linked-to host file's bytes.
   *
   * `resolveInsideRepo` resolves through `realpath` instead, so containment is
   * decided on where the path lands rather than on how it is spelled. A symlink
   * that stays inside the checkout still resolves, because that is inside.
   *
   * It returns a repository-relative path whose every component is already
   * resolved, so re-joining it reaches the target without following a link
   * again. As in `assertWritable`, this narrows the swap window between the
   * check and the open rather than closing it; containment for the remaining
   * window is the sandbox the isolated jobs now run in.
   */
  const containedFile = (requested: string): string | null => {
    const relativePath = resolveInsideRepo(repoPath, requested);
    return relativePath === null ? null : resolve(repoPath, relativePath);
  };

  /**
   * Why a path did not resolve, in terms the agent can act on.
   *
   * A null resolution has two very different causes and the caller has to tell
   * them apart: nothing is there — by far the common one, because the model
   * guesses paths — or something is there that does not resolve to a `kind`
   * inside the checkout. `executeReadFile` keys "file not found" off ENOENT, so
   * reporting every miss as a security refusal would send an investigation
   * chasing a traversal error over a mistyped filename.
   *
   * This picks a message; it does not re-decide containment. That decision was
   * already made, by realpath, in `repo-paths.ts`.
   */
  const refusal = async (requested: string, kind: 'file' | 'directory'): Promise<Error> => {
    try {
      // `stat` follows the link, so an escaping symlink to something real still
      // lands here and is reported as the refusal it is.
      await stat(resolve(repoPath, requested));
    } catch {
      return new Error(`ENOENT: no such file or directory: ${requested}`);
    }
    return new Error(
      `path traversal blocked — ${requested} does not resolve to a ${kind} within the repository`,
    );
  };

  const containedFileOrThrow = async (requested: string): Promise<string> => {
    const resolved = containedFile(requested);
    if (resolved !== null) return resolved;
    throw await refusal(requested, 'file');
  };

  const containedDirOrThrow = async (requested: string): Promise<string> => {
    const relativePath = resolveDirInsideRepo(repoPath, requested);
    if (relativePath === null) throw await refusal(requested, 'directory');
    return resolve(repoPath, relativePath);
  };

  return {
    readFile: async (filePath: string): Promise<string> => {
      // Read a bounded window rather than the whole file, because the model
      // picks the path: slicing to 50KB after the fact decoded minified vendor
      // bundles in full to produce the same 50KB of output.
      const handle = await open(await containedFileOrThrow(filePath), 'r');
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

    exists: async (paths: string[]): Promise<string[]> => {
      const found: string[] = [];
      for (const path of paths) {
        // `containedFile` already answers "is this an existing regular file
        // inside the repository", and returns null rather than throwing for
        // missing, unreadable, or escaping paths.
        if (containedFile(path) !== null) found.push(path);
      }
      return found;
    },

    list: async (dirPath: string, recursive: boolean): Promise<string> => {
      const resolved = await containedDirOrThrow(dirPath);
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
