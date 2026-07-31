import type { Platform } from '../platform.js';
import { parsePythonFrames } from './python-frames.js';

const DEV_PATH_TAIL_START =
  '(?:(?:packages|apps|src|app|pages|components|lib|server|client|shared|cli|eval|test-fixtures|test-e2e|tests|__tests__|dist|build|assets)/|[A-Za-z0-9_.-]+\\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|svelte|py|go|rs))';

const HOME_ABS_PREFIX = new RegExp(
  `(?:[A-Za-z]:)?/(?:Users|home)/[^:\\s)\\]}>'"\\x60]*?/(?=${DEV_PATH_TAIL_START})`,
  'g',
);

const HOME_PREFIX_AFTER_URL_STRIP = new RegExp(
  `\\b(?:Users|home)/[^:\\s)\\]}>'"\\x60]*?/(?=${DEV_PATH_TAIL_START})`,
  'g',
);

/**
 * Scrub local dev origins and host-specific home-directory prefixes from text
 * before it is shown to reviewers. This intentionally targets localhost,
 * Vite's @fs prefix, and home-directory paths instead of stripping every
 * absolute path; production file:line:column frames should remain useful.
 */
export function scrubDevPaths(text: string): string {
  return text
    .replace(/\\/g, '/')
    .replace(/https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?/g, '')
    .replace(/\/@fs\//g, '/')
    .replace(/\b@fs\//g, '')
    .replace(HOME_ABS_PREFIX, '')
    .replace(HOME_PREFIX_AFTER_URL_STRIP, '');
}

/**
 * Extract source file paths from a stack trace string.
 * Handles V8/Node, Firefox/Safari, and Vite dev server formats.
 * Returns deduplicated relative paths, excluding node_modules.
 */
export function extractStackTraceFiles(
  stackTrace: string,
  platform: Platform = 'javascript',
): string[] {
  if (platform === 'python') {
    return parsePythonFrames(stackTrace).map((frame) => frame.path);
  }
  const paths = new Set<string>();
  // Per-line patterns to avoid cross-line false positives
  const patterns: RegExp[] = [
    /\(([^)]+?):\d+:\d+\)/g,               // V8: (src/App.vue:19:17)
    /at\s+([^\s(:]+):\d+/g,                // V8 bare: at src/App.vue:19
    /at\s+(https?:\/\/\S+?):\d+:\d+(?=\s|$)/g, // V8 bare URL (anonymous frame): at http://localhost:5174/src/App.vue:19:17
    /[@]([^\s@]+?):\d+:\d+/g,              // Firefox/Safari: func@http://localhost:5175/src/App.vue:19:17
  ];

  for (const line of stackTrace.split('\n')) {
    // Skip entire line if it references node_modules
    if (line.includes('node_modules')) continue;

    for (const pattern of patterns) {
      // Reset lastIndex since we reuse the regex across lines
      pattern.lastIndex = 0;
      for (const match of line.matchAll(pattern)) {
        let filePath = match[1];
        // Strip URL origin (http://localhost:5175/)
        filePath = filePath.replace(/^https?:\/\/[^/]+\//, '');
        // Strip Vite @fs/ prefix
        filePath = filePath.replace(/^@fs\//, '');
        // Check node_modules after URL stripping (e.g. http://localhost/node_modules/...)
        if (filePath.includes('node_modules')) continue;
        // Only keep source file extensions. Include ESM/CJS variants (.mjs/.cjs/
        // .mts/.cts) — modern bundlers emit .mjs, and missing them would make
        // hasNoAppFrames() falsely classify a real app frame as stackless.
        if (!filePath.match(/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|svelte|py|go|rs)$/)) continue;
        // Normalize to relative path
        const relative = filePath.replace(/^\//, '');
        // Skip absolute system paths (after URL/prefix stripping)
        if (relative.includes(':\\')) continue;
        // Skip paths that are clearly not project source (e.g. stripped @fs paths)
        if (relative.startsWith('Users/') || relative.includes('/Users/')) continue;
        if (relative.startsWith('home/') || relative.includes('/home/')) continue;
        paths.add(relative);
      }
    }
  }
  return [...paths];
}

/**
 * True when a stack trace contains no application source frames — i.e. it is
 * empty, or only references anonymous/eval/browser-internal or node_modules
 * frames. These are inherently unfixable by the agent (cross-origin
 * "Script error.", non-Error promise rejections), so callers can short-circuit
 * to needs_human before cloning the repo or spending an LLM/sandbox.
 *
 * Minified app-bundle frames (e.g. assets/index-abc123.js) DO count as app
 * frames — they may be source-mappable, so let the normal flow try and give up.
 */
/**
 * Keep only the frames that name a file the repository actually contains.
 *
 * A minified production stack names bundle artifacts (`assets/index-Dk3f8xBq.js`)
 * that exist nowhere in the customer's source. Passing those downstream is worse
 * than passing nothing: the scope-review middleware tells the agent that its
 * correct edit is "not referenced in the stack trace" and invites it to revert,
 * and the diff judge is told the error references a file the repo does not have.
 *
 * Mirrors the tracked-file resolution the Python path has always done via
 * `resolveFrames`, so both platforms narrow to real source before any consumer
 * reads the list. An empty result is the correct answer for an unsymbolicated
 * stack, and every consumer already treats empty as "no stack file information".
 */
export function resolveTrackedFiles(paths: string[], trackedFiles: Set<string>): string[] {
  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    const match = matchTrackedPath(raw, trackedFiles);
    if (match === null || seen.has(match)) continue;
    seen.add(match);
    resolved.push(match);
  }
  return resolved;
}

/** Exact hit, else the longest suffix of the path that is tracked. */
function matchTrackedPath(path: string, trackedFiles: Set<string>): string | null {
  if (trackedFiles.has(path)) return path;
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  // The frame is more specific than the repository: drop the build machine's
  // prefix off `/home/runner/work/app/src/main.ts`.
  for (let i = 1; i < segments.length; i++) {
    const candidate = segments.slice(i).join('/');
    if (trackedFiles.has(candidate)) return candidate;
  }

  // The repository is more specific than the frame. A monorepo builds from
  // `frontend/`, so the map records `src/main.ts` while `git ls-files` reports
  // `frontend/src/main.ts`, and stripping segments can never close that gap.
  // Only accept a single candidate: naming the wrong file sends the agent to
  // edit the wrong package, which is worse than naming none.
  const suffix = `/${segments.join('/')}`;
  let unique: string | null = null;
  for (const tracked of trackedFiles) {
    if (!tracked.endsWith(suffix)) continue;
    if (unique !== null) return null;
    unique = tracked;
  }
  return unique;
}

export function hasNoAppFrames(
  stackTrace: string,
  platform: Platform = 'javascript',
): boolean {
  return extractStackTraceFiles(stackTrace, platform).length === 0;
}
