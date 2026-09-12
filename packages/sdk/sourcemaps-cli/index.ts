import { readFile, writeFile, readdir, rm, realpath, stat } from 'node:fs/promises';
import { join, dirname, resolve, relative, sep, isAbsolute } from 'node:path';
import { stampCodeAndMap, stripSourceMappingURLDirectives, DEBUG_ID_TRAILER } from '../src/build/stamp';
import { computeDebugId } from '../src/build/debug-id';
import { uploadSourceMaps, type UploadEntry } from '../vite-plugin/upload';
import { parseSourceMapKey } from '../vite-plugin/sk-key';

export interface CliOptions {
  dir: string;
  key: string;
  format: string;
  keepMaps: boolean;
  dryRun: boolean;
  requireKey: boolean;
  projectRoot: string;
  logger: (line: string) => void;
  fetchImpl?: typeof fetch;
}
export interface CliSummary {
  stamped: number;
  uploaded: number;
  failed: Array<{ fileName: string; reason: string }>;
  removed: number;
  skipped: number;
}

const MAX_MAP_BYTES = 32 << 20;
const JS_FILE = /\.(m|c)?js$/;
const FORMATS = new Set(['es', 'iife', 'umd', 'cjs', 'system']);
const USAGE = 'usage: opslane-sourcemaps <build-dir> [--format es|iife|umd|cjs|system] [--project-root <dir>] [--keep-maps] [--dry-run] [--require-key]';
const MISSING_KEY = 'opslane-sourcemaps: OPSLANE_SOURCEMAP_KEY not set, skipping (maps left untouched)';

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    // Do not follow symlinks while walking: the build cannot modify an external tree.
    else if (entry.isFile()) yield full;
  }
}

function insideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function fileName(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface MapLocation { mapPath: string; fileName: string }
type MapLookup = MapLocation | { fileName: string; error: string } | null;

async function mapFor(root: string, jsPath: string, code: string, retainedMaps: Map<string, string[]>): Promise<MapLookup> {
  const directives = [...code.matchAll(/^[ \t]*(?:\/\/[@#][ \t]*sourceMappingURL[ \t]*=[ \t]*(\S+)|\/\*[@#][ \t]*sourceMappingURL[ \t]*=[ \t]*(\S+?)[ \t]*\*\/)[ \t]*\r?$/gm)];
  const directive = directives.at(-1);
  const target = directive?.[1] ?? directive?.[2];
  let candidate = target ? resolve(dirname(jsPath), target) : jsPath + '.map';
  let name = fileName(root, candidate);
  if (target && (/^[a-z][a-z0-9+.-]*:/i.test(target) || isAbsolute(target) || /^[A-Za-z]:[\\/]/.test(target))) {
    return { fileName: name, error: 'sourceMappingURL points outside the build directory' };
  }
  if (!target) {
    try { await stat(candidate); } catch {
      // --keep-maps strips the URL even for non-sibling maps. Find those by
      // their retained debug ID on a repeated run, then validate the bytes below.
      const debugId = DEBUG_ID_TRAILER.exec(code)?.[1];
      const matches = debugId ? retainedMaps.get(debugId) : undefined;
      if (matches?.length === 1) candidate = matches[0];
      else if (matches && matches.length > 1) return { fileName: name, error: 'multiple retained maps match the debug ID' };
      else return null;
      name = fileName(root, candidate);
    }
  }
  try {
    const real = await realpath(candidate);
    if (!insideRoot(root, real)) return { fileName: name, error: 'map resolves outside the build directory' };
    if (!(await stat(real)).isFile()) return { fileName: name, error: 'map is not a file' };
    return { mapPath: real, fileName: fileName(root, real) };
  } catch {
    return { fileName: name, error: 'map not found' };
  }
}

export function parseArgs(argv: string[], env: Record<string, string | undefined>): CliOptions | { error: string } | { skip: string } {
  let dir = '';
  let format = 'iife';
  let keepMaps = false;
  let dryRun = false;
  let requireKey = false;
  let projectRoot = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--format') {
      const value = argv[++i];
      if (!value || !FORMATS.has(value)) return { error: '--format must be one of es, iife, umd, cjs, system' };
      format = value;
    } else if (arg === '--project-root') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) return { error: '--project-root needs a value' };
      projectRoot = resolve(value);
    } else if (arg === '--keep-maps') keepMaps = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--require-key') requireKey = true;
    else if (arg.startsWith('-')) return { error: 'unknown flag; ' + USAGE };
    else if (!dir) dir = arg;
    else return { error: 'only one directory is accepted' };
  }
  if (!dir) return { error: USAGE };
  const key = env['OPSLANE_SOURCEMAP_KEY'] ?? '';
  if (!key) return requireKey
    ? { error: 'OPSLANE_SOURCEMAP_KEY is not set; mint one under Settings > API keys (scope: sourcemaps)' }
    : { skip: MISSING_KEY };
  const parsed = parseSourceMapKey(key);
  if (!parsed.ok) return { error: `OPSLANE_SOURCEMAP_KEY is not a valid source-map key (${parsed.reason})` };
  return { dir, key, format, keepMaps, dryRun, requireKey, projectRoot, logger: (line) => console.log(line) };
}

export async function runSourcemapsCli(opts: CliOptions): Promise<CliSummary> {
  const summary: CliSummary = { stamped: 0, uploaded: 0, failed: [], removed: 0, skipped: 0 };
  if (!opts.key && !opts.requireKey) { opts.logger(MISSING_KEY); return summary; }
  const parsedKey = parseSourceMapKey(opts.key);
  if (!parsedKey.ok) throw new Error(`invalid source-map key (${parsedKey.reason})`);
  if (!FORMATS.has(opts.format)) throw new Error('unsupported output format');
  const root = await realpath(resolve(opts.dir));
  const log = (line: string): void => opts.logger(line.replaceAll(opts.key, '[redacted]'));
  const fail = (name: string, reason: string): void => {
    summary.failed.push({ fileName: name, reason: reason.replaceAll(opts.key, '[redacted]') });
  };
  const files: string[] = [];
  const retainedMaps = new Map<string, string[]>();
  for await (const path of walk(root)) {
    files.push(path);
    if (!path.endsWith('.map')) continue;
    try {
      if ((await stat(path)).size > MAX_MAP_BYTES) continue;
      const map: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (isObject(map) && typeof map.debugId === 'string') {
        const paths = retainedMaps.get(map.debugId) ?? [];
        paths.push(path);
        retainedMaps.set(map.debugId, paths);
      }
    } catch { /* The associated chunk reports an unreadable map below. */ }
  }
  type Work = UploadEntry & { jsPath: string; mapPath: string; code: string; dirty: boolean };
  const work: Work[] = [];
  for (const jsPath of files.filter((path) => JS_FILE.test(path))) {
    let name = fileName(root, jsPath + '.map');
    try {
      const code = await readFile(jsPath, 'utf8');
      const found = await mapFor(root, jsPath, code, retainedMaps);
      if (!found) { summary.skipped++; continue; }
      name = found.fileName;
      if ('error' in found) { fail(name, found.error); continue; }
      if ((await stat(found.mapPath)).size > MAX_MAP_BYTES) throw new Error('map over 32 MiB limit');
      const raw = await readFile(found.mapPath);
      const mapSource = new TextDecoder('utf-8', { fatal: true }).decode(raw);
      const parsedMap: unknown = JSON.parse(mapSource);
      const trailer = DEBUG_ID_TRAILER.exec(code);
      if (trailer || (isObject(parsedMap) && parsedMap.debugId !== undefined) || /\/\/# debugId=/.test(code)) {
        let recomputed: string;
        try { recomputed = (await computeDebugId(raw)).debugId; }
        catch (error) { throw new Error(`stale stamp: ${messageOf(error)}`); }
        if (!trailer || !isObject(parsedMap) || trailer[1] !== parsedMap.debugId || recomputed !== trailer[1]) {
          throw new Error('stale stamp: trailer, map debugId, and fingerprint disagree');
        }
        work.push({ debugId: trailer[1], mapSource, fileName: name, jsPath, mapPath: found.mapPath, code, dirty: false });
      } else {
        const out = await stampCodeAndMap({ code, mapSource: raw, mapFileName: name, format: opts.format, projectRoot: resolve(opts.projectRoot), outDir: root, maxMapBytes: MAX_MAP_BYTES });
        summary.stamped++;
        work.push({ debugId: out.debugId, mapSource: out.mapSource, fileName: name, jsPath, mapPath: found.mapPath, code: out.code, dirty: true });
        log(`stamped ${fileName(root, jsPath)} ${out.debugId}`);
      }
    } catch (error) { fail(name, messageOf(error)); }
  }
  if (opts.dryRun) {
    log(`dry run: ${summary.stamped} to stamp, ${work.length} to upload, ${summary.skipped} skipped`);
    return summary;
  }

  const ready: Work[] = [];
  for (const artifact of work) {
    try {
      if (artifact.dirty) {
        await writeFile(artifact.mapPath, artifact.mapSource);
        await writeFile(artifact.jsPath, artifact.code);
      }
      ready.push(artifact);
    } catch (error) { fail(artifact.fileName, messageOf(error)); }
  }
  const outcome = await uploadSourceMaps(ready, { endpoint: parsedKey.url, key: opts.key, fetchImpl: opts.fetchImpl });
  summary.uploaded = outcome.uploaded;
  for (const failure of outcome.failed) fail(failure.fileName, failure.reason);
  const failed = new Set(outcome.failed.map((failure) => failure.fileName));
  for (const artifact of ready) {
    if (failed.has(artifact.fileName)) { log(`kept ${artifact.fileName}: upload failed`); continue; }
    try {
      await writeFile(artifact.jsPath, stripSourceMappingURLDirectives(artifact.code));
      if (!opts.keepMaps) { await rm(artifact.mapPath); summary.removed++; }
    } catch (error) { fail(artifact.fileName, messageOf(error)); }
  }
  for (const failure of summary.failed) log(`${failure.fileName}: ${failure.reason}`);
  log(`opslane-sourcemaps: stamped ${summary.stamped}, uploaded ${summary.uploaded}, removed ${summary.removed}, skipped ${summary.skipped}, failed ${summary.failed.length}`);
  return summary;
}
