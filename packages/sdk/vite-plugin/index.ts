import type { Plugin, UserConfig } from 'vite';
import { computeDebugId } from '../src/build/debug-id.js';
import { parseSourceMapKey } from './sk-key.js';
import {
  uploadSourceMaps,
  type UploadEntry,
} from './upload.js';
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
  logLevel?: 'silent' | 'warn';
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
  skipped: Map<string, number>;
  verifyFailed: string[];
}

/**
 * The name this plugin registers under, frozen as an export.
 *
 * Tooling that installs the plugin has to confirm it is actually present in a
 * resolved Vite config, and the only handle it gets is this string. Comparing
 * against a copy pasted into another package makes a rename a silent
 * 100%-failure: the install looks fine, the check never matches, and a correct
 * edit gets rolled back. Import this instead of retyping it.
 *
 * Deliberately not `opslane-source-map`: that name belonged to the legacy
 * uploader removed in 3.0.0. Never reuse it, or tooling that still encounters
 * old builds could confuse the two.
 */
export const OPSLANE_VITE_PLUGIN_NAME = 'opslane-debug-ids';

/** Every extension Vite emits JavaScript under, and the maps beside them. */
const JS_ASSET = /\.(?:js|mjs|cjs)$/;
const JS_ASSET_MAP = /\.(?:js|mjs|cjs)\.map$/;

/** The stamped `//# debugId=` trailer, used to recognise an already-stamped file. */
const DEBUG_ID_TRAILER =
  /\n\/\/# debugId=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Thrown by `stampOne` so callers can tell a size refusal from a bad map. */
class MapTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`map is ${formatBytes(bytes)}, over the limit`);
    this.name = 'MapTooLargeError';
  }
}

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
  /** Final stamped map bytes, used when the privacy mode removes maps. */
  const uploadPayloads = new Map<string, UploadEntry>();
  /** Maps removed from the bundle, re-checked on disk after the build writes. */
  const discardedMaps = new Set<string>();
  const loggedCodes = new Set<string>();
  let stampingEnabled = options.stamp !== false;
  let sourcemapSetting: 'default' | 'hidden' | 'true' | 'inline' | 'false' =
    'default';
  /** True when this plugin, not the project, switched source maps on. */
  let pluginRequestedMaps = false;
  let projectRoot: string | undefined;
  let fileEnv: Record<string, string> = {};
  /** Where the build wrote, captured so closeBundle can re-read it. */
  let writtenDir: string | undefined;
  let outDir = 'dist';
  const commit = detectCommit(options.commitSha);

  const skip = (reason: string, _fileName: string): void => {
    stats.skipped.set(reason, (stats.skipped.get(reason) ?? 0) + 1);
  };
  const warnOnce = (code: string, message: string): void => {
    if (logLevel === 'silent' || loggedCodes.has(code)) return;
    loggedCodes.add(code);
    console.warn(`[opslane] ${code}: ${message}`);
  };

  /**
   * Will source maps remain in the build output?
   *
   * The plugin removes only the maps it caused to exist. With no
   * `build.sourcemap` of its own it switches maps on so there is something to
   * fingerprint, and removing them again is undoing that side effect. A
   * `build.sourcemap` the project set itself was not caused here: those maps
   * are usually wanted by an uploader that reads them off disk once the build
   * writes, and deleting them breaks that tool with a green build and no
   * message.
   *
   * Deliberately keyed on `pluginRequestedMaps` rather than `stampingEnabled`.
   * SRI detection switches stamping off in `configResolved`, which runs after
   * `config` has already asked for the maps, so a stamping check here would
   * leave maps on disk that only this plugin caused.
   */
  const mapsWillShip = (): boolean => !pluginRequestedMaps || keepSourceMaps;

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
    if (raw.byteLength > maxMapBytes) throw new MapTooLargeError(raw.byteLength);

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
    if (mapsWillShip()) return;
    for (const key of Object.keys(bundle)) {
      if (!JS_ASSET_MAP.test(key)) continue;
      // Only maps belonging to something this build emitted. An unrelated map
      // copied in as a static asset is the project's business, not ours.
      if (!(stripMapSuffix(key) in bundle)) continue;
      delete bundle[key];
      discardedMaps.add(key);
    }
  };

  /**
   * Removing a map from the bundle is not the same as it never reaching disk.
   * A plugin ordered after this one can write it back, and its `writeBundle`
   * runs after ours, so the question can only be settled in `closeBundle`.
   *
   * Warn rather than unlink. By that point the file is another plugin's
   * output, and deleting it could break something the project meant to have.
   */
  const reportRestoredMaps = (): void => {
    if (!writtenDir || discardedMaps.size === 0 || logLevel === 'silent') return;
    const readFileSync = nodeFs()?.readFileSync;
    if (!readFileSync) return;
    const restored = [...discardedMaps].filter((fileName) => {
      try {
        readFileSync(`${writtenDir}/${fileName}`);
        return true;
      } catch {
        return false;
      }
    });
    if (restored.length === 0) return;
    console.error(
      `[opslane] OPSLANE_VITE_MAP_NOT_REMOVED: ${restored.length} source map(s) reached disk after being removed from the bundle, publishing your original source. A plugin ordered after this one restored them.\n  Affected: ${restored.join(', ')}\n  See docs/guides/source-maps.md#plugin-order.`,
    );
  };

  /** Re-read retained maps at upload time and only send bytes that still
   * match the debug ID stamped into their JavaScript. */
  const collectVerifiedFromDisk = async (): Promise<UploadEntry[]> => {
    const readFileSync = nodeFs()?.readFileSync;
    if (!writtenDir || !readFileSync) return [];
    const entries: UploadEntry[] = [];
    for (const [fileName, expectedID] of stampedIds) {
      if (
        stats.verifyFailed.some((failure) => failure.startsWith(fileName))
      ) {
        continue;
      }
      try {
        const bytes = readFileSync(`${writtenDir}/${fileName}`);
        const { debugId } = await computeDebugId(bytes);
        if (debugId !== expectedID) {
          warnOnce(
            'OPSLANE_VITE_UPLOAD_STALE_MAP',
            `${fileName} changed on disk after verification; skipping its upload.`,
          );
          continue;
        }
        entries.push({
          debugId,
          mapSource: new TextDecoder().decode(bytes),
          fileName,
        });
      } catch {
        // A later plugin may have removed a map after writeBundle.
      }
    }
    return entries;
  };

  /** The build summary's source-map sentence. */
  const describeMaps = (): string => {
    if (sourcemapSetting === 'false') return 'Source maps: disabled.';
    if (sourcemapSetting === 'inline') return 'Source maps: inline in the chunks.';
    const setting = sourcemapSetting === 'default' ? 'hidden' : sourcemapSetting;
    return `Source maps: ${setting}, ${
      mapsWillShip() ? 'kept in output' : 'removed from output'
    }.`;
  };

  /** Why a file could not be stamped. Shared so both paths report alike. */
  const reportStampFailure = (fileName: string, error: unknown): void => {
    if (error instanceof MapTooLargeError) {
      skip(`map over ${formatBytes(maxMapBytes)}`, fileName);
      warnOnce(
        'OPSLANE_VITE_MAP_TOO_LARGE',
        `${fileName}'s map is ${formatBytes(error.bytes)}, above maxMapBytes=${formatBytes(maxMapBytes)}. The file was left unchanged. Raise maxMapBytes or reduce the map. See docs/guides/source-maps.md#map-size-limit.`,
      );
      return;
    }
    skip('invalid map', fileName);
    warnOnce(
      'OPSLANE_VITE_MAP_INVALID',
      `${fileName} was left unchanged because its map could not be fingerprinted (${messageOf(error)}). Fix or disable the plugin producing the invalid map. See docs/guides/source-maps.md#diagnostics.`,
    );
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
    if (!JS_ASSET.test(value.fileName)) return;
    if (typeof value.source !== 'string') return;
    if (!mapsWillShip()) {
      value.source = stripSourceMappingURLDirectives(value.source);
    }

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
      // JavaScript with its own map that no hook of ours ever saw. A worker is
      // the usual cause, but any plugin can emit this shape, so report what is
      // observable and offer the likely reason rather than asserting it. The
      // map is discarded with the rest, so the only lasting symptom is a file
      // that can never be symbolicated.
      skip('emitted without a debug ID', value.fileName);
      warnOnce(
        'OPSLANE_VITE_ASSET_UNSTAMPED',
        `${value.fileName} was emitted with a source map but no debug ID, so its errors cannot be symbolicated. It came from a build pass this plugin does not run in. Vite builds web workers separately, so the usual cause is a missing worker.plugins entry. See docs/guides/source-maps.md#web-workers.`,
      );
      return;
    }

    // Discarding is the sweep's job; recording what to verify on disk is this one's.
    const settle = (debugId: string): void => {
      if (mapsWillShip()) stampedIds.set(mapKey, debugId);
    };

    // Already consistent: the map beside it is the one that was fingerprinted.
    // A nested build that does run this plugin lands here, and it is stamped.
    try {
      const { debugId } = await computeDebugId(assetBytes(mapAsset));
      if (debugId === existing[1]) {
        stats.stamped++;
        settle(debugId);
        uploadPayloads.set(mapKey, {
          debugId,
          mapSource: typeof mapAsset.source === 'string'
            ? mapAsset.source
            : new TextDecoder().decode(mapAsset.source),
          fileName: mapKey,
        });
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
      uploadPayloads.set(mapKey, {
        debugId: stamped.debugId,
        mapSource: stamped.mapSource,
        fileName: mapKey,
      });
    } catch (error) {
      reportStampFailure(value.fileName, error);
    }
  };

  return {
    name: OPSLANE_VITE_PLUGIN_NAME,
    apply: 'build',
    enforce: 'post',

    buildStart() {
      stats.chunks = 0;
      stats.stamped = 0;
      stats.skipped.clear();
      stats.verifyFailed.length = 0;
      stampedIds.clear();
      uploadPayloads.clear();
      discardedMaps.clear();
      writtenDir = undefined;
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
        pluginRequestedMaps = true;
      }
      if (commit) {
        result.define = {
          [COMMIT_SHA_GLOBAL]: JSON.stringify(commit.sha),
        };
      }
      return result;
    },

    async configResolved(config) {
      projectRoot = canonicalFilesystemPath(config.root);
      outDir = isAbsolutePath(config.build.outDir)
        ? canonicalFilesystemPath(config.build.outDir)
        : config.build.outDir;
      const pluginNames = new Set(config.plugins.map((plugin) => plugin.name));
      const detectedSRI = [...KNOWN_SRI_PLUGINS].find((name) =>
        pluginNames.has(name),
      );
      if (detectedSRI) {
        stampingEnabled = false;
        console.error(
          `[opslane] OPSLANE_VITE_SRI_DETECTED: ${detectedSRI} computes integrity before debug-ID stamping. Stamping was disabled to prevent browsers rejecting every chunk. Remove the integrity plugin or set stamp:false explicitly. See docs/guides/source-maps.md#subresource-integrity.`,
        );
      }
      if (maxMapBytes > DEFAULT_MAX_MAP_BYTES) {
        warnOnce(
          'OPSLANE_VITE_MAP_OVER_SERVER_LIMIT',
          `maxMapBytes=${formatBytes(maxMapBytes)} exceeds the server upload limit of ${formatBytes(DEFAULT_MAX_MAP_BYTES)}; larger maps will stamp but fail to upload.`,
        );
      }
      const { loadEnv } = await import('vite');
      fileEnv = loadEnv(config.mode || 'production', config.root, 'OPSLANE_');
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
        if (!mapsWillShip()) {
          chunk.code = stripSourceMappingURLDirectives(chunk.code);
        }

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

        try {
          const stamped = await stampOne(chunk.code, mapAsset, prelude);

          // Atomic mutation: nothing above this point changes the bundle.
          chunk.code = stamped.code;
          mapAsset.source = stamped.mapSource;
          uploadPayloads.set(mapKey, {
            debugId: stamped.debugId,
            mapSource: stamped.mapSource,
            fileName: mapKey,
          });
          // Vite and Rollup both re-serialise from `chunk.map` on some paths
          // (workers, later code rewrites), so the map object has to agree
          // with the asset or a different map reaches disk than was hashed.
          applyStampToChunkMap(chunk.map, stamped.mapSource);
          stats.stamped++;

          // Discarding is `discardRetiredMaps`'s job, below.
          if (mapsWillShip()) stampedIds.set(mapKey, stamped.debugId);
        } catch (error) {
          reportStampFailure(chunk.fileName, error);
        }
      }

      discardRetiredMaps(bundle);
      },
    },

    // Verification reads the emitted file, not the in-memory asset: only the
    // bytes on disk are what an upload will be fingerprinted from.
    async writeBundle(outputOptions, bundle) {
      const dir = outputOptions.dir;
      if (!dir) return;
      const fs = nodeFs();
      const readFileSync = fs?.readFileSync;
      if (!readFileSync) return;

      writtenDir = dir;
      if (stampedIds.size === 0) return;

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

    async closeBundle() {
      reportRestoredMaps();

      // One variable configures uploads: the key carries its own destination.
      const rawKey = process.env['OPSLANE_SOURCEMAP_KEY']
        ?? fileEnv['OPSLANE_SOURCEMAP_KEY'];
      if (process.env['OPSLANE_ENDPOINT'] ?? fileEnv['OPSLANE_ENDPOINT']) {
        warnOnce(
          'OPSLANE_VITE_ENDPOINT_REMOVED',
          'OPSLANE_ENDPOINT is no longer used: the key itself carries the upload URL. Remove the variable.',
        );
      }
      if (rawKey) {
        const parsed = parseSourceMapKey(rawKey);
        if (!parsed.ok) {
          // The reason is a stable token from the shared vector contract, never
          // any part of the key itself.
          warnOnce(
            'OPSLANE_VITE_KEY_INVALID',
            `OPSLANE_SOURCEMAP_KEY is not a valid endpoint-bearing key (${parsed.reason}). `
            + 'Re-mint the key with a current server; bare keys from before the format change are no longer accepted. Upload skipped.',
          );
        } else {
          const entries = mapsWillShip()
            ? await collectVerifiedFromDisk()
            : [...uploadPayloads.values()];
          const outcome = await uploadSourceMaps(entries, {
            endpoint: parsed.url,
            key: rawKey,
          });
          if (outcome.failed.length > 0 && logLevel !== 'silent') {
            console.error(
              `[opslane] OPSLANE_VITE_UPLOAD_FAILED: ${outcome.failed.length} source map(s) failed to upload; stack traces for these chunks will stay minified.`
              + (keepSourceMaps
                ? ' The listed .map files are still in your build output — do not deploy them.'
                : '')
              + `\n  ${outcome.failed.map((failure) => `${failure.fileName}: ${failure.reason}`).join('\n  ')}`,
            );
          }
          if (logLevel !== 'silent') {
            console.warn(`[opslane] Uploaded ${outcome.uploaded}/${entries.length} source maps.`);
          }
        }
      }

      if (logLevel === 'silent') return;
      const skipped = stats.chunks - stats.stamped;
      const detail = [...stats.skipped.entries()]
        .map(([reason, count]) => `${count} ${reason}`)
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
        } ${describeMaps()}`,
      );
    },
  };
}

export { opslaneVitePlugin as opslane };

// opslaneSourceMapPlugin (the release-keyed legacy uploader, later a
// hard-fail stub) was removed in 3.0.0. opslane() uploads maps itself when
// OPSLANE_SOURCEMAP_KEY is set — that one variable carries the upload URL, so
// the separate endpoint variable is gone too. Old imports now fail at build
// time with a missing-export error, and `opslane sourcemaps install-plugin`
// still detects and reports configs that reference the old name.


function stripMapSuffix(filePath: string): string {
  return filePath.endsWith('.map') ? filePath.slice(0, -4) : filePath;
}

/**
 * Remove standalone source-map URL directives when maps are private.
 *
 * Each replacement leaves the newline itself in place, so generated line
 * numbers and the sibling map stay aligned. Anchoring to a whole trimmed line
 * avoids corrupting libraries that parse the directive with a regex or carry
 * the text in a string literal.
 */
function stripSourceMappingURLDirectives(code: string): string {
  return code
    .replace(
      /^[ \t]*\/\*[@#][ \t]*sourceMappingURL[ \t]*=[^\r\n]*?\*\/[ \t]*(?=\r?$)/gm,
      '',
    )
    .replace(
      /^[ \t]*\/\/[@#][ \t]*sourceMappingURL[ \t]*=[^\r\n]*(?=\r?$)/gm,
      '',
    );
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
