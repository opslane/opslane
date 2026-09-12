import { tokenizer } from 'acorn';
import { AnyMap, encodedMappings, type SectionedSourceMapInput } from '@jridgewell/trace-mapping';
import { computeDebugId, DebugIdError } from './debug-id.js';
import { DEBUG_ID_PLACEHOLDER, REGISTRY_GLOBAL } from './registry-contract.js';

export interface StampInput {
  code: string;
  mapSource: string | Uint8Array;
  mapFileName: string;
  format: string | undefined;
  /** Internal Vite override when reversing a previously selected prelude. */
  prelude?: string;
  projectRoot: string | undefined;
  outDir: string;
  maxMapBytes: number;
}

export interface StampResult {
  code: string;
  mapSource: string;
  debugId: string;
  contentSha256: string;
}

export async function stampCodeAndMap(input: StampInput): Promise<StampResult> {
  const { code, mapFileName, projectRoot, outDir, maxMapBytes } = input;
  const prelude = input.prelude ?? preludeForFormat(input.format);
  if (!prelude) throw new Error('unsupported output format');
  const raw = assetBytes({ source: input.mapSource });
  if (raw.byteLength > maxMapBytes) throw new MapTooLargeError(raw.byteLength);
  // Retain strict UTF-8/JSON validation before parsing can erase duplicate keys.
  try {
    await computeDebugId(raw);
  } catch (error) {
    if (!(error instanceof DebugIdError) || error.reason !== 'indexed_map') throw error;
  }
  const parsed = flattenIndexedMap(JSON.parse(new TextDecoder().decode(raw)) as unknown);
  if (!isSourceMapObject(parsed) || typeof parsed.mappings !== 'string') {
    throw new Error('map root or mappings field is invalid');
  }
  if (!/^[A-Za-z0-9+/,;]*$/.test(parsed.mappings)) throw new Error('invalid source map mappings');
  await computeDebugId(new TextEncoder().encode(JSON.stringify(parsed)));
  const insertion = preludeInsertion(code);
  const correctedMap = {
    ...normalizeSources(parsed, mapFileName, projectRoot, outDir),
    mappings: insertMappingLines(parsed.mappings, insertion.generatedLine, insertion.addedLines),
  };
  const fingerprint = await computeDebugId(new TextEncoder().encode(JSON.stringify(correctedMap)));
  return {
    code: insertion.head + prelude.split(DEBUG_ID_PLACEHOLDER).join(fingerprint.debugId)
      + code.slice(insertion.offset) + `\n//# debugId=${fingerprint.debugId}`,
    mapSource: JSON.stringify({ ...correctedMap, debugId: fingerprint.debugId }),
    ...fingerprint,
  };
}

/** Flatten section offsets and remap source/name indexes before fingerprinting. */
export function flattenIndexedMap(map: unknown): unknown {
  if (!isSourceMapObject(map) || !('sections' in map)) return map;
  validateSections(map);
  const flat = AnyMap(map as unknown as SectionedSourceMapInput);
  return {
    version: 3, ...(flat.file === undefined ? {} : { file: flat.file }),
    sources: flat.sources,
    // The upload fingerprint contract accepts complete text content only.
    ...(flat.sourcesContent?.every((source) => typeof source === 'string')
      ? { sourcesContent: flat.sourcesContent } : {}),
    names: flat.names, mappings: encodedMappings(flat),
    ...(flat.ignoreList ? { ignoreList: flat.ignoreList } : {}),
  };
}

function validateSections(map: Record<string, unknown>): void {
  if (map.version !== 3 || !Array.isArray(map.sections)) throw new Error('invalid indexed source map');
  let lastLine = -1;
  let lastColumn = -1;
  for (const section of map.sections) {
    if (!isSourceMapObject(section) || !isSourceMapObject(section.offset) || !isSourceMapObject(section.map)) {
      throw new Error('indexed source map requires embedded maps and offsets');
    }
    const { line, column } = section.offset;
    if (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 0
      || typeof column !== 'number' || !Number.isSafeInteger(column) || column < 0
      || line < lastLine || (line === lastLine && column <= lastColumn)) {
      throw new Error('invalid indexed source map offset');
    }
    lastLine = line;
    lastColumn = column;
    if ('sections' in section.map) validateSections(section.map);
    else if (section.map.version !== 3 || typeof section.map.mappings !== 'string'
      || !/^[A-Za-z0-9+/,;]*$/.test(section.map.mappings)
      || !Array.isArray(section.map.sources) || !section.map.sources.every((source: unknown) => typeof source === 'string')
      || !Array.isArray(section.map.names) || !section.map.names.every((name: unknown) => typeof name === 'string')) {
      throw new Error('invalid indexed source map section');
    }
  }
}

const ESM_PRELUDE = `;(function(){try{var g=typeof globalThis!=="undefined"?globalThis:self;var r=g.${REGISTRY_GLOBAL};if(!r||typeof r!=="object"){r=g.${REGISTRY_GLOBAL}=Object.create(null)}var k=import.meta.url;if(k){var a=r[k];if(!a){a=r[k]=[]}if(a.indexOf("${DEBUG_ID_PLACEHOLDER}")<0){a.push("${DEBUG_ID_PLACEHOLDER}")}}}catch(e){}})();\n`;

const SCRIPT_PRELUDE = `;(function(){try{var g=typeof globalThis!=="undefined"?globalThis:self;var r=g.${REGISTRY_GLOBAL};if(!r||typeof r!=="object"){r=g.${REGISTRY_GLOBAL}=Object.create(null)}var d=typeof document!=="undefined"&&document.currentScript;var k=d&&d.src;if(k){var a=r[k];if(!a){a=r[k]=[]}if(a.indexOf("${DEBUG_ID_PLACEHOLDER}")<0){a.push("${DEBUG_ID_PLACEHOLDER}")}}}catch(e){}})();\n`;

export const DEBUG_ID_TRAILER =
  /\n\/\/# debugId=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;


export function stripMapSuffix(filePath: string): string {
  return filePath.endsWith('.map') ? filePath.slice(0, -4) : filePath;
}

interface SourceMappingDirective {
  start: number;
  end: number;
  url: string;
}

function sourceMappingDirectives(code: string): SourceMappingDirective[] {
  if (!code.includes('sourceMappingURL')) return [];
  const directives: SourceMappingDirective[] = [];
  const tokens = tokenizer(code, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    onComment(_block, text, start, end) {
      const match = /^[@#][ \t]*sourceMappingURL[ \t]*=[ \t]*(\S+)[ \t]*$/.exec(text);
      if (match) directives.push({ start, end, url: match[1] });
    },
  });
  // Lexing distinguishes comments from regexes and template/string contents
  // without requiring the emitted chunk to be a complete program.
  while (tokens.getToken().type.label !== 'eof') { /* Consume comment callbacks. */ }
  return directives;
}

/** The last actual source-map directive wins, including comments after code. */
export function getSourceMappingURL(code: string): string | undefined {
  return sourceMappingDirectives(code).at(-1)?.url;
}

/** Remove directives without moving generated lines or columns. */
export function stripSourceMappingURLDirectives(code: string): string {
  let stripped = '';
  let offset = 0;
  for (const directive of sourceMappingDirectives(code)) {
    stripped += code.slice(offset, directive.start)
      + code.slice(directive.start, directive.end).replace(/[^\r\n\u2028\u2029]/g, ' ');
    offset = directive.end;
  }
  return stripped + code.slice(offset);
}

/**
 * Reverse the stamp so the file can be fingerprinted against the map that will
 * actually ship beside it. The prelude and trailer are both reconstructible
 * from the embedded ID, so this is exact or it fails.
 */
export function unstamp(
  code: string,
  debugId: string,
  format: string | undefined,
): { code: string; prelude: string } | null {
  const trailer = `\n//# debugId=${debugId}`;
  if (!code.endsWith(trailer)) return null;
  const body = code.slice(0, -trailer.length);

  const preferred = preludeForFormat(format);
  const candidates = [
    ...(preferred ? [preferred] : []),
    ESM_PRELUDE,
    SCRIPT_PRELUDE,
  ];
  for (const prelude of candidates) {
    const stamped = prelude.split(DEBUG_ID_PLACEHOLDER).join(debugId);
    const index = body.indexOf(stamped);
    if (index === -1) continue;
    return {
      code: body.slice(0, index) + body.slice(index + stamped.length),
      prelude,
    };
  }
  return null;
}

export function preludeForFormat(format: string | undefined): string | null {
  if (format === 'es') return ESM_PRELUDE;
  if (
    format === 'iife' ||
    format === 'umd' ||
    format === 'cjs' ||
    format === 'system'
  ) {
    return SCRIPT_PRELUDE;
  }
  return null;
}

/**
 * Where the prelude goes, and what the generated code looks like before it.
 *
 * The prelude has to run before the module's own code but must not displace a
 * shebang or a directive prologue: put it ahead of `"use strict"` and the
 * directive becomes an ordinary string expression, silently dropping the whole
 * chunk into sloppy mode.
 *
 * `head` is emitted verbatim ahead of the prelude and `code.slice(offset)`
 * follows it, so `addedLines` counts every generated line the pair introduces.
 */
function preludeInsertion(code: string): {
  head: string;
  offset: number;
  generatedLine: number;
  addedLines: number;
} {
  // A shebang is only a shebang at byte zero, so it can never be re-emitted.
  let shebangEnd = 0;
  if (code.startsWith('#!')) {
    const newline = code.indexOf('\n');
    shebangEnd = newline === -1 ? code.length : newline + 1;
  }

  // A directive ends at a semicolon or, under automatic semicolon insertion,
  // at the newline alone. The terminator after a semicolon is optional too: a
  // minified CJS chunk opens `"use strict";const a=1,...` all on one line.
  //
  // A newline only ends the statement when the next line cannot continue the
  // expression. `"x"\n(foo)` is a call and `"x"\n[0]` is a member access, so
  // neither string is a directive and splitting them changes what the code
  // does. The lookahead refuses the bare-newline form in front of anything
  // that keeps the expression going.
  const directives =
    /^(?:[ \t]*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')[ \t]*(?:;[ \t]*(?:\r?\n)?|\r?\n(?![ \t]*[([+\-*\/,.`?:=])))+/;
  const match = directives.exec(code.slice(shebangEnd));
  const prologueEnd = shebangEnd + (match ? match[0].length : 0);

  // The common case: the prologue ends on a line boundary, so the prelude gets
  // a line of its own and everything below it shifts down exactly one.
  if (prologueEnd === 0 || code[prologueEnd - 1] === '\n') {
    return {
      head: code.slice(0, prologueEnd),
      offset: prologueEnd,
      generatedLine: code.slice(0, prologueEnd).split('\n').length - 1,
      addedLines: 1,
    };
  }

  // The prologue shares its line with real code. Splitting them would move that
  // code off column zero and invalidate every column on the line, so re-emit
  // the prologue on a line of its own and leave the original bytes untouched
  // below the prelude. The repeated directive is a harmless no-op: it is no
  // longer in prologue position, and the copy above it already applies. Resume
  // the original bytes after the shebang rather than at zero, or the shebang is
  // duplicated into the middle of the file and the output stops being parseable.
  return {
    head: `${code.slice(0, prologueEnd)}\n`,
    offset: shebangEnd,
    generatedLine: code.slice(0, shebangEnd).split('\n').length - 1,
    addedLines: 2,
  };
}

function insertMappingLines(
  mappings: string,
  generatedLine: number,
  count: number,
): string {
  const lines = mappings.split(';');
  const at = Math.min(generatedLine, lines.length);
  lines.splice(at, 0, ...new Array<string>(count).fill(''));
  return lines.join(';');
}

export function assetBytes(asset: { source: string | Uint8Array }): Uint8Array {
  if (typeof asset.source === 'string') {
    return new TextEncoder().encode(asset.source);
  }
  if (asset.source instanceof Uint8Array) return asset.source;
  throw new Error('map asset source is not text');
}

function isSourceMapObject(
  value: unknown,
): value is Record<string, unknown> & { mappings: string } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeSources(
  map: Record<string, unknown> & { mappings: string },
  mapFileName: string,
  projectRoot: string | undefined,
  outDir: string,
): Record<string, unknown> & { mappings: string } {
  if (
    !projectRoot ||
    map.sourceRoot !== undefined ||
    !Array.isArray(map.sources) ||
    !map.sources.every((source) => typeof source === 'string')
  ) {
    return map;
  }

  const root = normalizePath(projectRoot);
  const mapDirectory = normalizePath(
    `${isAbsolutePath(outDir) ? outDir : `${root}/${outDir}`}/${directoryOf(
      mapFileName,
    )}`,
  );
  const sources = map.sources.map((source) => {
    if (
      source.includes('://') ||
      source.startsWith('data:') ||
      source.startsWith('\0')
    ) {
      return source;
    }
    const candidates = [
      normalizePath(
        isAbsolutePath(source) ? source : `${mapDirectory}/${source}`,
      ),
    ];
    const strippedParents = source.replace(/^(?:\.\.\/)+/, '');
    if (strippedParents !== source) {
      candidates.push(
        normalizePath(
          /^[A-Za-z]:\//.test(strippedParents)
            ? strippedParents
            : `/${strippedParents}`,
        ),
      );
    }
    for (const resolved of candidates) {
      if (resolved === root) return '.';
      if (resolved.startsWith(`${root}/`)) {
        return resolved.slice(root.length + 1);
      }
    }
    return source;
  });
  return { ...map, sources };
}

export function normalizePath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  const prefix = normalized.startsWith('/')
    ? '/'
    : /^[A-Za-z]:\//.exec(normalized)?.[0] ?? '';
  const rest = prefix ? normalized.slice(prefix.length) : normalized;
  const parts: string[] = [];
  for (const part of rest.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') {
        parts.pop();
      } else if (!prefix) {
        parts.push(part);
      }
      continue;
    }
    parts.push(part);
  }
  return `${prefix}${parts.join('/')}` || (prefix === '/' ? '/' : '.');
}

export function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
}

export function directoryOf(fileName: string): string {
  const normalized = fileName.replaceAll('\\', '/');
  const slash = normalized.lastIndexOf('/');
  return slash === -1 ? '' : normalized.slice(0, slash);
}

export function canonicalFilesystemPath(value: string): string {
  const processLike = (
    globalThis as {
      process?: {
        getBuiltinModule?: (
          name: string,
        ) => { realpathSync?: (path: string) => string };
      };
    }
  ).process;
  const realpathSync = processLike?.getBuiltinModule?.('node:fs').realpathSync;
  if (!realpathSync) return normalizePath(value);
  try {
    return normalizePath(realpathSync(value));
  } catch {
    const parent = directoryOf(value);
    if (!parent || parent === value) return normalizePath(value);
    const name = value.replaceAll('\\', '/').slice(parent.length + 1);
    return normalizePath(`${canonicalFilesystemPath(parent)}/${name}`);
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${Math.ceil(bytes / (1024 * 1024))} MiB`;
  }
  if (bytes >= 1024) return `${Math.ceil(bytes / 1024)} KiB`;
  return `${bytes} B`;
}

export class MapTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`map is ${formatBytes(bytes)}, over the limit`);
    this.name = 'MapTooLargeError';
  }
}
