import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, posix, relative } from 'node:path';

/** Which paths in a clone the worker is allowed to change. */
export interface FixSurface {
  /** null preserves the pre-existing whole-repository behavior. */
  globs: string[] | null;
}

export type CauseLocation =
  | { kind: 'repo_path'; path: string; line?: number }
  | { kind: 'external_system' }
  | { kind: 'vague' };

const PATH_SEGMENT = /^[\w.@+-]+$/;
const EXTERNAL_SIGNALS: RegExp[] = [
  /^[a-z][a-z0-9+.-]*:\/\//i,
  /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\/\S/,
  /\((?:remote|external|third[- ]party)[^)]*\)/i,
  /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|cloud|app)\b/i,
];

/** Parse only positively identifiable repository paths and external systems. */
export function parseCauseLocation(causeLocation: string): CauseLocation {
  const raw = (causeLocation ?? '').trim().replace(/^[`'"]+|[`'"]+$/g, '');
  if (!raw) return { kind: 'vague' };

  // Accept the citation forms models actually produce: `file`, `file:42`,
  // `file:36-39` (a range) and `file:42:9` (line and column). Only a bare line
  // number parsed before, so a real run that cited
  // `lib/core/InterceptorManager.js:36-39` with the correct file had its whole
  // diagnosis discarded as unciteable.
  const match = /^\.?\/?([^\s:]+?)(?::(\d+)(?:[-:]\d+)?)?$/.exec(raw);
  const pathCandidate = match?.[1];
  const looksLikePath =
    pathCandidate !== undefined &&
    (/\.[A-Za-z0-9]+$/.test(pathCandidate) || /^(Dockerfile|Makefile|Procfile)$/i.test(pathCandidate)) &&
    pathCandidate
      .split('/')
      .every((segment) => segment !== '' && segment !== '.' && segment !== '..' && PATH_SEGMENT.test(segment));

  if (!looksLikePath || !pathCandidate) {
    return EXTERNAL_SIGNALS.some((signal) => signal.test(raw))
      ? { kind: 'external_system' }
      : { kind: 'vague' };
  }

  const line = match?.[2] ? Number(match[2]) : undefined;
  if (line === undefined || line < 1) return { kind: 'repo_path', path: pathCandidate };
  return { kind: 'repo_path', path: pathCandidate, line };
}

function globToRegExp(glob: string): RegExp {
  let output = '^';
  for (let index = 0; index < glob.length; index++) {
    const character = glob[index]!;
    if (character === '*') {
      if (glob[index + 1] === '*') {
        index++;
        if (glob[index + 1] === '/') {
          index++;
          output += '(?:.*/)?';
        } else {
          output += '.*';
        }
      } else {
        output += '[^/]*';
      }
    } else if ('.+?^${}()|[]\\'.includes(character)) {
      output += `\\${character}`;
    } else {
      output += character;
    }
  }
  return new RegExp(`${output}$`);
}

export function isInsideFixSurface(path: string, surface: FixSurface): boolean {
  if (surface.globs === null) return true;
  return surface.globs.some((glob) => globToRegExp(glob).test(path));
}

/**
 * Resolve a cited path to its real location inside the clone, or null if it
 * escapes, is missing, or is not a regular file.
 *
 * Glob matching is lexical, so on its own it is bypassable: a symlink at
 * `client/vendor` pointing to `../server` makes `client/vendor/app.py` match a
 * `client/**` surface while the bytes being edited live in the backend.
 * Verification confirmed this authorised a write outside the surface. Callers
 * must match the glob against the path this returns, never the cited string.
 */
export function resolveInsideRepo(repoPath: string, cited: string): string | null {
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
    if (!statSync(target).isFile()) return null;
  } catch {
    return null;
  }
  return relative(repoReal, target);
}

/** As resolveInsideRepo, but for a directory. Returns '' for the repo root. */
function resolveDirInsideRepo(repoPath: string, cited: string): string | null {
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
    if (!statSync(target).isDirectory()) return null;
  } catch {
    return null;
  }
  return relative(repoReal, target);
}

/** Thrown when a write is attempted outside the configured fix surface. */
export class FixSurfaceViolation extends Error {
  constructor(readonly cited: string, readonly resolved: string | null) {
    super(
      resolved === null
        ? `Refusing to write ${cited}: it does not resolve inside the repository`
        : `Refusing to write ${cited}: it resolves to ${resolved}, outside the configured fix surface`,
    );
    this.name = 'FixSurfaceViolation';
  }
}

/**
 * The authorization check that guards a write, run immediately before it.
 *
 * resolveInsideRepo answers a different question at a different time: whether a
 * path the *diagnosis* cited exists. This answers whether the path about to be
 * written is inside the surface, and fails closed on anything it cannot resolve.
 *
 * Creates resolve through the parent directory, because resolveInsideRepo
 * requires an existing regular file and fixes legitimately add files.
 *
 * This narrows the window; it does not eliminate it. A symlink swapped between
 * this call and the write would still win. Closing that fully needs the write
 * to go through a descriptor opened with O_NOFOLLOW rather than a path, which
 * is out of scope here and recorded in the plan's known gaps.
 */
export function assertWritable(repoPath: string, cited: string, surface: FixSurface): string {
  const existing = resolveInsideRepo(repoPath, cited);
  if (existing !== null) {
    if (!isInsideFixSurface(existing, surface)) throw new FixSurfaceViolation(cited, existing);
    return existing;
  }

  // Not an existing file: treat it as a create and authorize via the parent.
  const parent = dirname(cited);
  const name = basename(cited);
  if (!name || name === '.' || name === '..') throw new FixSurfaceViolation(cited, null);

  const parentReal = resolveDirInsideRepo(repoPath, parent);
  if (parentReal === null) throw new FixSurfaceViolation(cited, null);

  const target = parentReal === '' ? name : `${parentReal}/${name}`;
  if (!isInsideFixSurface(target, surface)) throw new FixSurfaceViolation(cited, target);
  return target;
}

/**
 * The same authorization question for a path inside the fix sandbox.
 *
 * `assertWritable` cannot be used there: the repository lives on a remote E2B
 * filesystem, so `realpathSync` would resolve the worker's disk, not the one
 * being written. This normalises lexically instead — enough to stop `..`
 * traversal and an out-of-surface path, and it fails closed on anything it
 * cannot place.
 *
 * The gap it leaves, stated plainly: it cannot follow a symlink, so a link
 * inside the surface pointing outside it still authorises the write. Closing
 * that needs a realpath executed *in* the sandbox, which costs a round trip per
 * write. Containment for that case remains the sandbox itself.
 */
export function assertWritableSandboxPath(repoRoot: string, cited: string, surface: FixSurface): string {
  const trimmed = (cited ?? '').trim();
  if (!trimmed) throw new FixSurfaceViolation(cited, null);

  const root = posix.normalize(repoRoot).replace(/\/+$/, '');
  const absolute = trimmed.startsWith('/') ? trimmed : posix.join(root, trimmed);
  const normalized = posix.normalize(absolute);
  if (!normalized.startsWith(`${root}/`)) throw new FixSurfaceViolation(cited, null);

  const relativePath = normalized.slice(root.length + 1);
  if (!relativePath) throw new FixSurfaceViolation(cited, null);
  if (!isInsideFixSurface(relativePath, surface)) throw new FixSurfaceViolation(cited, relativePath);
  return normalized;
}

/**
 * Every path a unified diff would write, as repository-relative strings.
 *
 * Returns an empty list when it can find no target, and the caller must treat
 * that as a refusal: a patch whose targets we cannot read is a patch we cannot
 * authorize.
 */
export function diffTargets(diff: string): string[] {
  const out = new Set<string>();
  for (const line of (diff ?? '').split('\n')) {
    const match = /^(?:\+\+\+|---)\s+(?:[ab]\/)?(\S+)/.exec(line);
    const path = match?.[1];
    if (!path || path === '/dev/null') continue;
    out.add(path);
  }
  return [...out];
}
