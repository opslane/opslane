import { realpathSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

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
