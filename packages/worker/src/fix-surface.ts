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

  const match = /^\.?\/?([^\s:]+?)(?::(\d+))?$/.exec(raw);
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
