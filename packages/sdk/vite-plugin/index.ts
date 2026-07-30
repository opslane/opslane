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
      mappings: insertMappingLine(parsed.mappings, insertion.generatedLine),
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
        code.slice(0, insertion.offset) +
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
  const restampEmittedAsset = async (
    value: { type: string; fileName: string; source?: string | Uint8Array },
    bundle: Record<string, unknown>,
    format: string | undefined,
  ): Promise<void> => {
    if (!stampingEnabled) return;
    if (!value.fileName.endsWith('.js')) return;
    if (typeof value.source !== 'string') return;

    const existing = DEBUG_ID_TRAILER.exec(value.source);
    if (!existing) return;

    const mapKey = `${value.fileName}.map`;
    const mapAsset = (bundle as Record<string, MapAsset | undefined>)[mapKey];
    if (!mapAsset || mapAsset.type !== 'asset') return;

    const settle = (debugId: string): void => {
      if (mapsRetained()) {
        stampedIds.set(mapKey, debugId);
      } else {
        delete bundle[mapKey];
      }
    };

    // Already consistent: the map beside it is the one that was fingerprinted.
    try {
      const { debugId } = await computeDebugId(assetBytes(mapAsset));
      if (debugId === existing[1]) {
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

    stats.chunks++;
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
