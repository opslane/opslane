import type { Plugin, UserConfig } from 'vite';
import { computeDebugId } from '../src/build/debug-id.js';
import {
  COMMIT_SHA_GLOBAL,
  DEBUG_ID_PLACEHOLDER,
  REGISTRY_GLOBAL,
} from '../src/build/registry-contract.js';

export interface OpslaneViteOptions {
  /** Explicit build provenance override. */
  commitSha?: string;
  /** Disable mutation for integrity-checked builds. Defaults to true. */
  stamp?: boolean;
  /** Diagnostic verbosity. Defaults to warn. */
  logLevel?: 'silent' | 'warn' | 'debug';
  /** Retain or remove generated source-map assets. Defaults to remove. */
  sourcemaps?: 'remove' | 'keep';
  /** Maximum raw source-map asset size. Defaults to 32 MiB. */
  maxMapBytes?: number;
}

const DEFAULT_MAX_MAP_BYTES = 32 * 1024 * 1024;
const KNOWN_SRI_PLUGINS = new Set([
  'vite-plugin-sri',
  'rollup-plugin-sri',
  '@small-tech/vite-plugin-sri',
  'vite-plugin-manifest-sri',
]);

const ESM_PRELUDE = `;(function(){try{var g=typeof globalThis!=="undefined"?globalThis:self;var r=g.${REGISTRY_GLOBAL};if(!r||typeof r!=="object"){r=g.${REGISTRY_GLOBAL}=Object.create(null)}var k=import.meta.url;if(k){var a=r[k];if(!a){a=r[k]=[]}if(a.indexOf("${DEBUG_ID_PLACEHOLDER}")<0){a.push("${DEBUG_ID_PLACEHOLDER}")}}}catch(e){}})();\n`;
const SCRIPT_PRELUDE = `;(function(){try{var g=typeof globalThis!=="undefined"?globalThis:self;var r=g.${REGISTRY_GLOBAL};if(!r||typeof r!=="object"){r=g.${REGISTRY_GLOBAL}=Object.create(null)}var d=typeof document!=="undefined"&&document.currentScript;var k=d&&d.src;if(k){var a=r[k];if(!a){a=r[k]=[]}if(a.indexOf("${DEBUG_ID_PLACEHOLDER}")<0){a.push("${DEBUG_ID_PLACEHOLDER}")}}}catch(e){}})();\n`;

interface StampStats {
  chunks: number;
  stamped: number;
  skipped: Map<string, string[]>;
  verifyFailed: string[];
}

/** The stamped `//# debugId=` trailer, used to recognise an already-stamped file. */
const DEBUG_ID_TRAILER =
  /\n\/\/# debugId=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

interface StampResult {
  code: string;
  mapSource: string;
  debugId: string;
}

export function opslaneVitePlugin(
  options: OpslaneViteOptions = {},
): Plugin {
  const logLevel = options.logLevel ?? 'warn';
  const maxMapBytes = options.maxMapBytes ?? DEFAULT_MAX_MAP_BYTES;
  const keepSourceMaps = options.sourcemaps === 'keep';
  const stats: StampStats = {
    chunks: 0,
    stamped: 0,
    skipped: new Map(),
    verifyFailed: [],
  };
  // Per-build state. Cleared at buildStart so watch rebuilds and multiple
  // outputs never verify against a previous build's fingerprints.
  const stampedIds = new Map<string, string>();
  const loggedCodes = new Set<string>();
  let stampingEnabled = options.stamp !== false;
  let sourcemapSetting: 'default' | 'hidden' | 'true' | 'inline' | 'false' =
    'default';
  let legacyPluginPresent = false;
  let projectRoot: string | undefined;
  let outDir = 'dist';
  const commit = detectCommit(options.commitSha);

  const skip = (reason: string, fileName: string): void => {
    const files = stats.skipped.get(reason) ?? [];
    files.push(fileName);
    stats.skipped.set(reason, files);
  };
  const warnOnce = (code: string, message: string): void => {
    if (logLevel === 'silent' || loggedCodes.has(code)) return;
    loggedCodes.add(code);
    console.warn(`[opslane] ${code}: ${message}`);
  };

  /** Maps are only kept in the output when one of these is true. */
  const mapsRetained = (): boolean =>
    keepSourceMaps || legacyPluginPresent || sourcemapSetting === 'true';

  /**
   * Fingerprint `mapAsset` as it stands, then return the code and map bytes
   * that carry that fingerprint. Nothing here mutates the bundle.
   */
  const stampOne = async (
    code: string,
    mapAsset: { source: string | Uint8Array; fileName: string },
    prelude: string,
  ): Promise<StampResult> => {
    const raw = assetBytes(mapAsset);
    if (raw.byteLength > maxMapBytes) {
      throw new Error(`map is ${formatBytes(raw.byteLength)}, over the limit`);
    }

    // Strictly validate the raw artifact before JSON.parse can erase
    // duplicate keys or normalize malformed input.
    await computeDebugId(raw);
    const parsed = JSON.parse(new TextDecoder().decode(raw)) as unknown;
    if (!isSourceMapObject(parsed) || typeof parsed.mappings !== 'string') {
      throw new Error('map root or mappings field is invalid');
    }

    const insertion = preludeInsertion(code);
    const correctedMap = {
      ...normalizeSources(parsed, mapAsset.fileName, projectRoot, outDir),
      mappings: insertMappingLines(
        parsed.mappings,
        insertion.generatedLine,
        insertion.addedLines,
      ),
    };
    const correctedMapSource = JSON.stringify(correctedMap);
    const fingerprint = await computeDebugId(
      new TextEncoder().encode(correctedMapSource),
    );
    const stampedPrelude = prelude
      .split(DEBUG_ID_PLACEHOLDER)
      .join(fingerprint.debugId);
    if (stampedPrelude.includes(DEBUG_ID_PLACEHOLDER)) {
      throw new Error('debug-ID placeholder substitution failed');
    }

    return {
      code:
        insertion.head +
        stampedPrelude +
        code.slice(insertion.offset) +
        `\n//# debugId=${fingerprint.debugId}`,
      mapSource: JSON.stringify({
        ...correctedMap,
        debugId: fingerprint.debugId,
      }),
      debugId: fingerprint.debugId,
    };
  };

  /**
   * Vite emits a worker build's output into the parent bundle as plain assets.
   * When the file name is already taken Rollup keeps the *existing* asset
   * source, so a worker chunk's stamped JS can replace the parent's chunk while
   * the parent's unstamped map survives beside it. Re-fingerprint those files
   * against the map that is actually going to ship.
   */
  /**
   * `sourcemaps: 'remove'` is a privacy promise, not a size optimisation: a map
   * that reaches disk publishes the original source under a predictable URL.
   *
   * Stamping gives up for reasons outside this plugin's control. The loudest is
   * a worker: Vite runs `worker.plugins` as a separate build and copies the
   * result into the parent bundle as plain assets, so a project that lists the
   * plugin only under `plugins` hands us worker JavaScript that no hook ever
   * stamped. Every one of those paths used to leave the sibling map in the
   * bundle while the build summary still reported the maps as removed.
   *
   * Sweeping last keeps the promise regardless of what happened above.
   */
  const discardRetiredMaps = (bundle: Record<string, unknown>): void => {
    // With stamping off the plugin is not managing maps at all: it never asked
    // for them to be generated, so deleting someone else's is not its call.
    if (!stampingEnabled || mapsRetained()) return;
    for (const key of Object.keys(bundle)) {
      if (!key.endsWith('.js.map')) continue;
      // Only maps belonging to something this build emitted. An unrelated map
      // copied in as a static asset is the project's business, not ours.
      if (!(stripMapSuffix(key) in bundle)) continue;
      delete bundle[key];
    }
  };

  const restampEmittedAsset = async (
    value: { type: string; fileName: string; source?: string | Uint8Array },
    bundle: Record<string, unknown>,
    format: string | undefined,
  ): Promise<void> => {
    if (!stampingEnabled) return;
    if (!value.fileName.endsWith('.js')) return;
    if (typeof value.source !== 'string') return;

    const mapKey = `${value.fileName}.map`;
    const mapAsset = (bundle as Record<string, MapAsset | undefined>)[mapKey];
    if (!mapAsset || mapAsset.type !== 'asset') return;

    // JavaScript with a sibling map is a stamping candidate however it got here,
    // so it belongs in the denominator. Counting it only on the paths that
    // succeed lets `skip()` record a reason the summary then hides, because the
    // summary derives its skipped count from chunks minus stamped.
    stats.chunks++;

    const existing = DEBUG_ID_TRAILER.exec(value.source);
    if (!existing) {
      // JavaScript with its own map that no hook of ours ever saw: a nested
      // build ran without this plugin. The map is discarded with the rest, so
      // the only lasting symptom is a chunk that can never be symbolicated.
      skip('nested build not stamped', value.fileName);
      warnOnce(
        'OPSLANE_VITE_NESTED_BUILD_UNSTAMPED',
        `${value.fileName} came from a nested build that does not run this plugin, so it has no debug ID and its errors cannot be symbolicated. Vite builds web workers separately: add the plugin to worker.plugins as well as plugins. See docs/guides/source-maps.md#web-workers.`,
      );
      return;
    }

    const settle = (debugId: string): void => {
      if (mapsRetained()) {
        stampedIds.set(mapKey, debugId);
      } else {
        delete bundle[mapKey];
      }
    };

    // Already consistent: the map beside it is the one that was fingerprinted.
    // A nested build that does run this plugin lands here, and it is stamped.
    try {
      const { debugId } = await computeDebugId(assetBytes(mapAsset));
      if (debugId === existing[1]) {
        stats.stamped++;
        settle(debugId);
        return;
      }
    } catch {
      // Unfingerprintable as it stands; the rebuild below is the only chance.
    }

    const unstamped = unstamp(value.source, existing[1], format);
    if (!unstamped) {
      skip('stamped by another tool', value.fileName);
      return;
    }

    try {
      const stamped = await stampOne(
        unstamped.code,
        mapAsset,
        unstamped.prelude,
      );
      value.source = stamped.code;
      mapAsset.source = stamped.mapSource;
      stats.stamped++;
      settle(stamped.debugId);
    } catch (error) {
      skip('invalid map', value.fileName);
      warnOnce(
        'OPSLANE_VITE_MAP_INVALID',
        `${value.fileName} was left unchanged because its map could not be fingerprinted (${messageOf(error)}). Fix or disable the plugin producing the invalid map. See docs/guides/source-maps.md#diagnostics.`,
      );
    }
  };

  return {
    name: 'opslane-debug-ids',
    apply: 'build',
    enforce: 'post',

    buildStart() {
      stats.chunks = 0;
      stats.stamped = 0;
      stats.skipped.clear();
      stats.verifyFailed.length = 0;
      stampedIds.clear();
    },

    config(config: UserConfig) {
      const hasExplicitSourcemap =
        config.build !== undefined &&
        Object.prototype.hasOwnProperty.call(config.build, 'sourcemap');
      if (hasExplicitSourcemap) {
        const configured = config.build?.sourcemap;
        sourcemapSetting =
          configured === true
            ? 'true'
            : configured === 'hidden'
              ? 'hidden'
              : configured === 'inline'
                ? 'inline'
                : 'false';
        if (configured === false || configured === 'inline') {
          stampingEnabled = false;
          if (configured === 'inline') {
            warnOnce(
              'OPSLANE_VITE_INLINE_MAP',
              "Inline maps have no separate asset to fingerprint and publish sources with the chunk. Use build.sourcemap:'hidden'. See docs/guides/source-maps.md#sourcemap-mode.",
            );
          } else {
            warnOnce(
              'OPSLANE_VITE_SOURCEMAP_DISABLED',
              "build.sourcemap is explicitly false, so no map exists to fingerprint. Remove the override or use 'hidden'. See docs/guides/source-maps.md#sourcemap-mode.",
            );
          }
        }
      }

      const result: UserConfig = {};
      if (!hasExplicitSourcemap && stampingEnabled) {
        result.build = { sourcemap: 'hidden' };
      }
      if (commit) {
        result.define = {
          [COMMIT_SHA_GLOBAL]: JSON.stringify(commit.sha),
        };
      }
      return result;
    },

    configResolved(config) {
      projectRoot = canonicalFilesystemPath(config.root);
      outDir = isAbsolutePath(config.build.outDir)
        ? canonicalFilesystemPath(config.build.outDir)
        : config.build.outDir;
      const pluginNames = new Set(config.plugins.map((plugin) => plugin.name));
      legacyPluginPresent = pluginNames.has('opslane-source-map');
      const detectedSRI = [...KNOWN_SRI_PLUGINS].find((name) =>
        pluginNames.has(name),
      );
      if (detectedSRI) {
        stampingEnabled = false;
        console.error(
          `[opslane] OPSLANE_VITE_SRI_DETECTED: ${detectedSRI} computes integrity before debug-ID stamping. Stamping was disabled to prevent browsers rejecting every chunk. Remove the integrity plugin or set stamp:false explicitly. See docs/guides/source-maps.md#subresource-integrity.`,
        );
      }
    },

    // `order: 'post'` is load-bearing. Vite's own `vite:build-import-analysis`
    // rewrites chunk code in generateBundle and re-serialises the sibling map
    // from `chunk.map`, discarding anything written earlier. Fingerprinting has
    // to happen after every other hook has finished moving bytes around.
    generateBundle: {
      order: 'post',
      async handler(outputOptions, bundle) {
      for (const value of Object.values(bundle)) {
        if (value.type !== 'chunk') {
          await restampEmittedAsset(value, bundle, outputOptions.format);
          continue;
        }
        stats.chunks++;
        const chunk = value;

        if (!stampingEnabled) {
          skip(
            sourcemapSetting === 'inline'
              ? 'inline map'
              : sourcemapSetting === 'false'
                ? 'sourcemap disabled'
                : 'stamping disabled',
            chunk.fileName,
          );
          continue;
        }

        const prelude = preludeForFormat(outputOptions.format);
        if (!prelude) {
          skip(`unsupported format ${String(outputOptions.format)}`, chunk.fileName);
          warnOnce(
            'OPSLANE_VITE_FORMAT_UNSUPPORTED',
            `Output format ${String(outputOptions.format)} has no safe runtime registry prelude, so affected chunks were left unchanged. Use es, iife, umd, cjs, or system. See docs/guides/source-maps.md#output-formats.`,
          );
          continue;
        }

        const mapKey = `${chunk.fileName}.map`;
        const mapAsset = bundle[mapKey];
        if (!mapAsset || mapAsset.type !== 'asset') {
          skip('no map', chunk.fileName);
          warnOnce(
            'OPSLANE_VITE_MAP_MISSING',
            'At least one emitted chunk had no sibling .map asset and was left unchanged. Check other plugins that remove maps and place the Opslane plugin before them. See docs/guides/source-maps.md#plugin-order.',
          );
          continue;
        }

        if (assetBytes(mapAsset).byteLength > maxMapBytes) {
          skip(`map over ${formatBytes(maxMapBytes)}`, chunk.fileName);
          warnOnce(
            'OPSLANE_VITE_MAP_TOO_LARGE',
            `${chunk.fileName}'s map is ${formatBytes(assetBytes(mapAsset).byteLength)}, above maxMapBytes=${formatBytes(maxMapBytes)}. The chunk was left unchanged. Raise maxMapBytes or reduce the map. See docs/guides/source-maps.md#map-size-limit.`,
          );
          continue;
        }

        try {
          const stamped = await stampOne(chunk.code, mapAsset, prelude);

          // Atomic mutation: nothing above this point changes the bundle.
          chunk.code = stamped.code;
          mapAsset.source = stamped.mapSource;
          // Vite and Rollup both re-serialise from `chunk.map` on some paths
          // (workers, later code rewrites), so the map object has to agree
          // with the asset or a different map reaches disk than was hashed.
          applyStampToChunkMap(chunk.map, stamped.mapSource);
          stats.stamped++;

          if (mapsRetained()) {
            stampedIds.set(mapKey, stamped.debugId);
          } else {
            delete bundle[mapKey];
          }
        } catch (error) {
          skip('invalid map', chunk.fileName);
          warnOnce(
            'OPSLANE_VITE_MAP_INVALID',
            `${chunk.fileName} was left unchanged because its map could not be fingerprinted (${messageOf(error)}). Fix or disable the plugin producing the invalid map. See docs/guides/source-maps.md#diagnostics.`,
          );
        }
      }

      discardRetiredMaps(bundle);
      },
    },

    // Verification reads the emitted file, not the in-memory asset: only the
    // bytes on disk are what an upload will be fingerprinted from.
    async writeBundle(outputOptions, bundle) {
      const dir = outputOptions.dir;
      if (!dir || stampedIds.size === 0) return;
      const readFileSync = nodeFs()?.readFileSync;
      if (!readFileSync) return;

      for (const [fileName, expectedId] of stampedIds) {
        // A map another plugin dropped from the bundle after we stamped was
        // never meant to ship (the legacy uploader does exactly this).
        if (!(fileName in bundle)) continue;
        let bytes: Uint8Array;
        try {
          bytes = readFileSync(`${dir}/${fileName}`);
        } catch {
          stats.verifyFailed.push(`${fileName} (map missing on disk)`);
          continue;
        }
        try {
          const { debugId } = await computeDebugId(bytes);
          if (debugId !== expectedId) stats.verifyFailed.push(fileName);
        } catch {
          stats.verifyFailed.push(`${fileName} (map unreadable)`);
        }
      }

      if (stats.verifyFailed.length > 0 && logLevel !== 'silent') {
        console.error(
          `[opslane] OPSLANE_VITE_MAP_VERIFY_FAILED: ${stats.verifyFailed.length} chunk(s) shipped a map that does not match the debug ID stamped into the JavaScript. Those chunks will be rejected on upload.\n  Affected: ${stats.verifyFailed.join(', ')}\n  See docs/guides/source-maps.md#verification.`,
        );
      }
    },

    closeBundle() {
      if (logLevel === 'silent') return;
      const skipped = stats.chunks - stats.stamped;
      const detail = [...stats.skipped.entries()]
        .map(([reason, files]) => `${files.length} ${reason}`)
        .join(', ');
      console.warn(
        `[opslane] Stamped ${stats.stamped}/${stats.chunks} chunks with debug IDs` +
          (skipped > 0 ? ` (${skipped} skipped: ${detail}).` : '.') +
          (stats.verifyFailed.length > 0
            ? ` ${stats.verifyFailed.length} failed on-disk verification.`
            : ''),
      );
      console.warn(
        `[opslane] ${
          commit
            ? `Commit ${commit.sha.slice(0, 7)} detected from ${commit.source}.`
            : 'Commit not detected.'
        } Source maps: ${sourcemapSetting === 'default' ? 'hidden' : sourcemapSetting}, ${
          mapsRetained() ? 'kept in output' : 'removed from output'
        }.`,
      );
    },
  };
}

export { opslaneVitePlugin as opslane };

export interface SourceMapPluginOptions {
  endpoint: string;
  apiKey: string;
  release?: string;
}

interface BundleAsset {
  type: string;
  source?: string;
  fileName: string;
}

interface CollectedMap {
  file_path: string;
  source_map: string;
}

/**
 * @deprecated Use opslaneVitePlugin for deterministic debug IDs. This legacy
 * uploader remains unchanged until the authenticated upload flow replaces it.
 */
export function opslaneSourceMapPlugin(_options: SourceMapPluginOptions) {
  return {
    name: 'opslane-source-map',
    apply: 'build' as const,
    enforce: 'post' as const,

    configResolved(): never {
      // Source-map upload moved to a batch API that does not exist yet
      // (tracked in #218). Failing the build is better than silently
      // deleting maps and uploading nothing, which is what a 404 here
      // would produce.
      throw new Error(
        '[opslane] source-map upload is unavailable in this release. ' +
        'Remove opslaneSourceMapPlugin() from your Vite plugins until @opslane/sdk ships batch upload ' +
        '(see opslane/opslane-oss#218).',
      );
    },
  };
}

/** Read VITE_OPSLANE_RELEASE without depending on @types/node globals. */
function readReleaseEnv(): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.VITE_OPSLANE_RELEASE;
}

function stripMapSuffix(filePath: string): string {
  return filePath.endsWith('.map') ? filePath.slice(0, -4) : filePath;
}

interface MapAsset {
  type: string;
  fileName: string;
  source: string | Uint8Array;
}

/**
 * Reverse the stamp so the file can be fingerprinted against the map that will
 * actually ship beside it. The prelude and trailer are both reconstructible
 * from the embedded ID, so this is exact or it fails.
 */
function unstamp(
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

/**
 * Mirror the stamped map onto `chunk.map`. It is a Rollup `SourceMap`
 * instance, so it may be frozen or expose accessors; every step is guarded and
 * a failure here never leaves an already-stamped chunk half-written.
 */
function applyStampToChunkMap(chunkMap: unknown, stampedMapSource: string): void {
  try {
    const asObject = JSON.parse(stampedMapSource) as Record<string, unknown>;
    if (
      chunkMap &&
      typeof chunkMap === 'object' &&
      !Object.isFrozen(chunkMap)
    ) {
      for (const key of [
        'mappings',
        'sources',
        'sourcesContent',
        'names',
        'debugId',
      ]) {
        if (key in asObject) {
          try {
            (chunkMap as Record<string, unknown>)[key] = asObject[key];
          } catch {
            // Accessor-only property on this engine; the asset write stands.
          }
        }
      }
    }
  } catch {
    // chunk.map is unwritable here. The asset write and the writeBundle
    // verification still apply.
  }
}

function nodeFs():
  | { readFileSync?: (path: string) => Uint8Array }
  | undefined {
  const processLike = (
    globalThis as {
      process?: {
        getBuiltinModule?: (
          name: string,
        ) => { readFileSync?: (path: string) => Uint8Array };
      };
    }
  ).process;
  try {
    return processLike?.getBuiltinModule?.('node:fs');
  } catch {
    return undefined;
  }
}

function preludeForFormat(format: string | undefined): string | null {
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
  let offset = 0;
  if (code.startsWith('#!')) {
    const newline = code.indexOf('\n');
    offset = newline === -1 ? code.length : newline + 1;
  }

  // The trailing terminator is optional: a minified CJS chunk opens
  // `"use strict";const a=1,...` with the whole program on one line.
  const directives =
    /^(?:[ \t]*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')[ \t]*;[ \t]*(?:\r?\n)?)+/;
  const match = directives.exec(code.slice(offset));
  if (match) offset += match[0].length;

  // The common case: the prologue ends on a line boundary, so the prelude gets
  // a line of its own and everything below it shifts down exactly one.
  if (offset === 0 || code[offset - 1] === '\n') {
    return {
      head: code.slice(0, offset),
      offset,
      generatedLine: code.slice(0, offset).split('\n').length - 1,
      addedLines: 1,
    };
  }

  // The prologue shares its line with real code. Splitting them would move that
  // code off column zero and invalidate every column on the line, so re-emit
  // the prologue on a line of its own and leave the original bytes untouched
  // below the prelude. The now-repeated directive is a harmless no-op: it is no
  // longer in prologue position, and the copy above it already applies.
  return {
    head: `${code.slice(0, offset)}\n`,
    offset: 0,
    generatedLine: 0,
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

function assetBytes(asset: { source: string | Uint8Array }): Uint8Array {
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

function normalizePath(value: string): string {
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

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
}

function directoryOf(fileName: string): string {
  const normalized = fileName.replaceAll('\\', '/');
  const slash = normalized.lastIndexOf('/');
  return slash === -1 ? '' : normalized.slice(0, slash);
}

function canonicalFilesystemPath(value: string): string {
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${Math.ceil(bytes / (1024 * 1024))} MiB`;
  }
  if (bytes >= 1024) return `${Math.ceil(bytes / 1024)} KiB`;
  return `${bytes} B`;
}

interface DetectedCommit {
  sha: string;
  source: string;
}

function detectCommit(explicit: string | undefined): DetectedCommit | null {
  if (explicit && isCommitSHA(explicit)) {
    return { sha: explicit, source: 'commitSha' };
  }
  const env = (
    globalThis as {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process?.env;
  const names = [
    'OPSLANE_COMMIT_SHA',
    'GITHUB_SHA',
    'VERCEL_GIT_COMMIT_SHA',
    'CF_PAGES_COMMIT_SHA',
    'CI_COMMIT_SHA',
    'RENDER_GIT_COMMIT',
    'BITBUCKET_COMMIT',
    'GIT_COMMIT',
    'BUILD_SOURCEVERSION',
  ];
  for (const name of names) {
    const value = env?.[name];
    if (value && isCommitSHA(value)) return { sha: value, source: name };
  }
  const gitCommit = readGitCommit();
  return gitCommit ? { sha: gitCommit, source: '.git/HEAD' } : null;
}

function isCommitSHA(value: string | undefined): boolean {
  return (
    typeof value === 'string' &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)
  );
}

function readGitCommit(): string | undefined {
  const processLike = (
    globalThis as {
      process?: {
        cwd?: () => string;
        getBuiltinModule?: (
          name: string,
        ) => {
          readFileSync?: (path: string, encoding: 'utf8') => string;
          statSync?: (path: string) => { isDirectory(): boolean };
        };
      };
    }
  ).process;
  const fs = processLike?.getBuiltinModule?.('node:fs');
  const cwd = processLike?.cwd?.();
  if (!fs?.readFileSync || !fs.statSync || !cwd) return undefined;

  const read = (path: string): string | undefined => {
    try {
      return fs.readFileSync?.(path, 'utf8').trim();
    } catch {
      return undefined;
    }
  };

  let directory = normalizePath(cwd);
  while (directory) {
    const dotGit = `${directory}/.git`;
    let gitDirectory = dotGit;
    try {
      if (!fs.statSync(dotGit).isDirectory()) {
        const pointer = read(dotGit);
        if (!pointer?.startsWith('gitdir: ')) return undefined;
        const target = pointer.slice('gitdir: '.length);
        gitDirectory = normalizePath(
          isAbsolutePath(target) ? target : `${directory}/${target}`,
        );
      }
    } catch {
      const parent = directoryOf(directory);
      if (!parent || parent === directory) break;
      directory = parent;
      continue;
    }

    const head = read(`${gitDirectory}/HEAD`);
    if (head && isCommitSHA(head)) return head;
    if (!head?.startsWith('ref: ')) return undefined;
    const reference = head.slice('ref: '.length);
    const direct = read(`${gitDirectory}/${reference}`);
    if (direct && isCommitSHA(direct)) return direct;

    const commonPointer = read(`${gitDirectory}/commondir`);
    const commonDirectory = commonPointer
      ? normalizePath(
          isAbsolutePath(commonPointer)
            ? commonPointer
            : `${gitDirectory}/${commonPointer}`,
        )
      : gitDirectory;
    const commonRef = read(`${commonDirectory}/${reference}`);
    if (commonRef && isCommitSHA(commonRef)) return commonRef;

    const packedRefs = read(`${commonDirectory}/packed-refs`);
    if (packedRefs) {
      for (const line of packedRefs.split('\n')) {
        if (line.startsWith('#') || line.startsWith('^')) continue;
        const [sha, name] = line.trim().split(/\s+/, 2);
        if (name === reference && isCommitSHA(sha)) return sha;
      }
    }
    return undefined;
  }
  return undefined;
}
