import { execFile } from 'node:child_process';
import { open, readdir, stat } from 'node:fs/promises';
import { normalize, resolve } from 'node:path';
import { promisify } from 'node:util';
import { MAX_LIST_ENTRIES, type RepoReader } from '../investigate-tools.js';
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
  const contained = (requested: string): string => {
    const resolved = resolve(repoPath, requested);
    // `resolve` removes a trailing separator. Keeping it here made the prefix
    // check compare against `repo//`, rejecting every valid child path when a
    // caller supplied a repository URL-derived path ending in `/`.
    const normalizedRepo = resolve(normalize(repoPath));
    if (!resolved.startsWith(normalizedRepo + '/') && resolved !== normalizedRepo) {
      throw new Error('path traversal blocked — path must be within the repository');
    }
    return resolved;
  };

  return {
    readFile: async (filePath: string): Promise<string> => {
      // Read a bounded window rather than the whole file, because the model
      // picks the path: slicing to 50KB after the fact decoded minified vendor
      // bundles in full to produce the same 50KB of output.
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

    exists: async (paths: string[]): Promise<string[]> => {
      const found: string[] = [];
      for (const path of paths) {
        try {
          if ((await stat(contained(path))).isFile()) found.push(path);
        } catch { /* missing, unreadable, or outside the repository */ }
      }
      return found;
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
