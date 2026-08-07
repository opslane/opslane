import { lstatSync, realpathSync, statSync, type Stats } from 'node:fs';
import { basename, dirname, join, posix, relative } from 'node:path';

/**
 * Resolve a cited path to its real location inside the clone, or null if it
 * escapes the clone, is missing, or is not the kind of entry asked for.
 *
 * Resolution goes through `realpathSync` rather than string normalisation,
 * because a lexical check is bypassable: a symlink at `client/vendor` pointing
 * to `../server` keeps `client/vendor/app.py` looking repository-relative while
 * the bytes being written live wherever the link points.
 */
function resolveInsideRepoIf(
  repoPath: string,
  cited: string,
  accept: (stats: Stats) => boolean,
): string | null {
  let repoReal: string;
  let target: string;
  try {
    repoReal = realpathSync(repoPath);
    target = realpathSync(join(repoReal, cited));
  } catch {
    return null;
  }
  if (target !== repoReal && !target.startsWith(`${repoReal}/`)) return null;
  try {
    if (!accept(statSync(target))) return null;
  } catch {
    return null;
  }
  return relative(repoReal, target);
}

/** Resolve a cited path to a regular file inside the clone, or null. */
export function resolveInsideRepo(repoPath: string, cited: string): string | null {
  return resolveInsideRepoIf(repoPath, cited, (stats) => stats.isFile());
}

/** As resolveInsideRepo, but for a directory. Returns '' for the repo root. */
function resolveDirInsideRepo(repoPath: string, cited: string): string | null {
  return resolveInsideRepoIf(repoPath, cited, (stats) => stats.isDirectory());
}

/** Thrown when a write would land outside the repository clone. */
export class WriteOutsideRepoError extends Error {
  constructor(readonly cited: string) {
    super(`Refusing to write ${cited}: it does not resolve inside the repository`);
    this.name = 'WriteOutsideRepoError';
  }
}

/**
 * The authorization check that guards a write, run immediately before it.
 *
 * resolveInsideRepo answers a different question at a different time: whether a
 * path the *diagnosis* cited exists. This answers whether the path about to be
 * written is inside the clone, and fails closed on anything it cannot resolve.
 *
 * Creates resolve through the parent directory, because resolveInsideRepo
 * requires an existing regular file and fixes legitimately add files.
 *
 * This narrows the window; it does not eliminate it. A symlink swapped between
 * this call and the write would still win. Closing that fully needs the write
 * to go through a descriptor opened with O_NOFOLLOW rather than a path, which
 * is out of scope here and recorded in the plan's known gaps.
 */
export function assertWritable(repoPath: string, cited: string): string {
  const existing = resolveInsideRepo(repoPath, cited);
  if (existing !== null) return existing;

  // `resolveInsideRepo` returned null for one of two very different reasons:
  // nothing is there (a create, which is fine), or something IS there that it
  // refused — a symlink leaving the repository, a directory, a FIFO.
  //
  // Falling straight through to the create path conflated them and was a real,
  // deterministic escape: a symlink at `repo/escape` -> `/tmp/secret` was
  // rejected by realpath, re-authorised as a create through its parent (which
  // is inside the repo), and the caller's write followed the link out. Verified
  // by writing through it before this guard existed.
  //
  // lstat does not follow the final component, so it answers "does anything
  // occupy this name" without being fooled by what the link points at.
  let occupied = false;
  try {
    lstatSync(join(repoPath, cited));
    occupied = true;
  } catch {
    // ENOENT: genuinely nothing there, so a create is legitimate.
  }
  if (occupied) throw new WriteOutsideRepoError(cited);

  const parent = dirname(cited);
  const name = basename(cited);
  if (!name || name === '.' || name === '..') throw new WriteOutsideRepoError(cited);

  const parentReal = resolveDirInsideRepo(repoPath, parent);
  if (parentReal === null) throw new WriteOutsideRepoError(cited);

  return parentReal === '' ? name : `${parentReal}/${name}`;
}

/**
 * The same authorization question for a path inside the fix sandbox.
 *
 * `assertWritable` cannot be used there: the repository lives on a remote E2B
 * filesystem, so `realpathSync` would resolve the worker's disk, not the one
 * being written. This normalises lexically instead — enough to stop `..`
 * traversal out of the clone, and it fails closed on anything it cannot place.
 *
 * The gap it leaves, stated plainly: it cannot follow a symlink, so a link
 * inside the clone pointing outside it still authorises the write. Closing that
 * needs a realpath executed *in* the sandbox, which costs a round trip per
 * write. Containment for that case remains the sandbox itself.
 */
export function assertWritableSandboxPath(repoRoot: string, cited: string): string {
  const trimmed = (cited ?? '').trim();
  if (!trimmed) throw new WriteOutsideRepoError(cited);

  const root = posix.normalize(repoRoot).replace(/\/+$/, '');
  // A repoRoot of "/" normalizes to "", and then every absolute path satisfies
  // the prefix test below. Refuse rather than authorize the whole filesystem.
  if (!root || !root.startsWith('/')) throw new WriteOutsideRepoError(cited);
  const absolute = trimmed.startsWith('/') ? trimmed : posix.join(root, trimmed);
  const normalized = posix.normalize(absolute);
  if (!normalized.startsWith(`${root}/`)) throw new WriteOutsideRepoError(cited);

  const relativePath = normalized.slice(root.length + 1);
  if (!relativePath) throw new WriteOutsideRepoError(cited);
  return normalized;
}

/**
 * Every path a unified diff would write, as repository-relative strings.
 *
 * These are applied with `patch -p1`, which strips exactly one leading path
 * component, so what is authorized has to be the path AFTER the strip. Reading
 * the header verbatim authorized a different file than patch wrote: a header of
 * `--- src/foo.ts` (no `a/` prefix) passed the gate as `src/foo.ts` while patch
 * stripped `src/` and wrote `foo.ts` at the repository root.
 *
 * The `a/`/`b/` prefix is therefore required rather than optional. It is what
 * makes the strip unambiguous, and every diff git produces already has it.
 *
 * Returns an empty list when it can find no target or any header is not in that
 * form, and the caller must treat that as a refusal: a patch whose targets we
 * cannot read is a patch we cannot authorize.
 */
export function diffTargets(diff: string): string[] {
  const out = new Set<string>();

  // Hunk bodies are consumed by line count, not by pattern, because a diff line
  // and a header are not distinguishable by shape. A removed source line is the
  // original line with a `-` prefix, so removing the SQL comment `-- seed data`
  // produces `--- seed data`, which read as a malformed header and refused the
  // entire patch; removing a line that happens to read `--- a/other.ts` added a
  // file the patch never touches to the authorized set. Both were reproduced
  // against this function before the counters existed.
  //
  // `@@ -old,count +new,count @@` states exactly how many lines follow, so the
  // body ends where the arithmetic says it ends and nothing inside it is read.
  let oldRemaining = 0;
  let newRemaining = 0;

  for (const line of (diff ?? '').split('\n')) {
    if (oldRemaining > 0 || newRemaining > 0) {
      // "\ No newline at end of file" annotates the previous line and is not
      // itself content, so it counts against neither side.
      if (line.startsWith('\\')) continue;
      if (line.startsWith('-')) oldRemaining--;
      else if (line.startsWith('+')) newRemaining--;
      else {
        // A context line, including the empty string git emits for a blank one.
        oldRemaining--;
        newRemaining--;
      }
      if (oldRemaining < 0 || newRemaining < 0) return []; // body contradicts its own header
      continue;
    }

    const hunkStart = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunkStart) {
      // An omitted count means exactly one line, which is what unified diff
      // shorthand `@@ -1 +1 @@` denotes.
      oldRemaining = hunkStart[1] === undefined ? 1 : Number(hunkStart[1]);
      newRemaining = hunkStart[2] === undefined ? 1 : Number(hunkStart[2]);
      continue;
    }

    // `---`/`+++` file headers. Only reachable outside a hunk body now.
    const header = /^(?:\+\+\+|---)\s+(\S+)/.exec(line);
    if (header?.[1]) {
      const path = header[1];
      if (path === '/dev/null') continue;
      // Refuse the whole patch, never just this header: a diff we can only
      // partially place is one we cannot authorize.
      if (!/^[ab]\/./.test(path)) return [];
      out.add(path.slice(2));
      continue;
    }

    // Git extended headers. `patch` honours these, so a rename or copy writes a
    // path that never appears in any `---`/`+++` line. Reading only hunk headers
    // meant a diff pairing one authorized file with a `rename to` section moved
    // a second, ungated file — confirmed against GNU patch, which reported
    // `patching file <target> (renamed from ...)` for a path this never saw.
    const extended = /^(?:rename|copy)\s+(?:from|to)\s+(\S+)$/.exec(line);
    if (extended?.[1]) {
      // These carry no `a/`/`b/` prefix and are already repository-relative.
      out.add(extended[1]);
      continue;
    }

    // Anything else that changes a file's identity or mode is a header shape
    // this parser does not model. Refuse rather than authorize what we cannot read.
    if (/^(?:deleted file mode|new file mode|old mode|new mode)\b/.test(line)) {
      const target = /^(?:deleted file|new file)/.test(line);
      if (target) continue; // covered by the /dev/null side of a hunk header
      return [];
    }
  }

  // A hunk that promised more lines than it delivered is a truncated patch.
  if (oldRemaining > 0 || newRemaining > 0) return [];

  return [...out];
}
