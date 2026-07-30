import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { containedRepoRelative } from '../onboard/paths.js';
import { snapshotRegularFile, type FileSnapshot } from '../onboard/snapshot.js';
import {
  DEFAULT_PLUGIN_CONTRACT,
  type PluginContractDeps,
} from './vite-contract.js';
import { installedPackageVersion } from './vite-resolve.js';

export const VITE_CONFIG_FILENAMES = [
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.ts',
  'vite.config.cjs',
  'vite.config.mts',
  'vite.config.cts',
] as const;

export type ViteDiscoveryStatus =
  | 'config_not_found'
  | 'multiple_configs'
  | 'unsafe_config'
  | 'vite_not_installed'
  | 'vite_version_unsupported'
  | 'sdk_not_installed'
  | 'plugin_not_available_yet';

export type ViteDiscoveryResult =
  | {
      ok: true;
      repoRoot: string;
      appDir: string;
      appRelative: string;
      configPath: string;
      configRelative: string;
      snapshot: FileSnapshot;
      viteVersion: string;
      sdkVersion: string;
    }
  | {
      ok: false;
      status: ViteDiscoveryStatus;
      message: string;
      candidates?: Array<{ file: string; hasIndexHtml: boolean }>;
    };

export interface ViteDiscoveryOptions {
  repoRoot: string;
  appDir?: string;
  config?: string;
  contract?: PluginContractDeps;
}

export interface ViteDiscoveryDeps {
  installedVersion?: (appDir: string, packageName: string) => Promise<string | null>;
}

function numericVersion(
  version: string,
): { numbers: [number, number, number]; prerelease: boolean } | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(-[-0-9A-Za-z.]+)?(?:\+[-0-9A-Za-z.]+)?$/);
  return match
    ? {
        numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
        prerelease: Boolean(match[4]),
      }
    : null;
}

export function versionAtLeast(version: string, minimum: string): boolean {
  const actual = numericVersion(version);
  const floor = numericVersion(minimum);
  if (!actual || !floor) return false;
  for (let index = 0; index < 3; index += 1) {
    if (actual.numbers[index]! > floor.numbers[index]!) return true;
    if (actual.numbers[index]! < floor.numbers[index]!) return false;
  }
  return !actual.prerelease || floor.prerelease;
}

export async function discoverViteProject(
  options: ViteDiscoveryOptions,
  deps: ViteDiscoveryDeps = {},
): Promise<ViteDiscoveryResult> {
  const contract = options.contract ?? DEFAULT_PLUGIN_CONTRACT;
  const versionReader = deps.installedVersion ?? installedPackageVersion;
  let appRelative: string;
  try {
    appRelative = containedRepoRelative(options.repoRoot, options.appDir ?? '.') || '.';
  } catch (error) {
    return {
      ok: false,
      status: 'unsafe_config',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const appDir = appRelative === '.'
    ? options.repoRoot
    : path.join(options.repoRoot, appRelative);
  try {
    if (!lstatSync(appDir).isDirectory()) {
      throw new Error(`App directory is not a directory: ${appRelative}`);
    }
  } catch (error) {
    return {
      ok: false,
      status: 'unsafe_config',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  let configRelatives: string[];
  if (options.config) {
    try {
      const candidate = path.isAbsolute(options.config)
        ? options.config
        : path.join(appRelative === '.' ? '' : appRelative, options.config);
      configRelatives = [containedRepoRelative(options.repoRoot, candidate)];
    } catch (error) {
      return {
        ok: false,
        status: 'unsafe_config',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  } else {
    configRelatives = VITE_CONFIG_FILENAMES
      .map((name) => appRelative === '.' ? name : path.posix.join(appRelative, name))
      .filter((relative) => existsSync(path.join(options.repoRoot, relative)));
  }

  if (configRelatives.length === 0) {
    return {
      ok: false,
      status: 'config_not_found',
      message: `No Vite config found in ${appRelative}; looked for ${VITE_CONFIG_FILENAMES.join(', ')}. Pass --config <path>.`,
    };
  }
  if (configRelatives.length > 1) {
    return {
      ok: false,
      status: 'multiple_configs',
      message: 'Several Vite configs were found; pass --config <path>.',
      candidates: configRelatives.map((file) => ({
        file,
        hasIndexHtml: existsSync(path.join(path.dirname(path.join(options.repoRoot, file)), 'index.html')),
      })),
    };
  }

  let snapshot: FileSnapshot;
  try {
    snapshot = snapshotRegularFile(options.repoRoot, configRelatives[0]!, 4 * 1024 * 1024);
  } catch (error) {
    return {
      ok: false,
      status: 'unsafe_config',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const viteVersion = await versionReader(appDir, 'vite');
  if (!viteVersion) {
    return {
      ok: false,
      status: 'vite_not_installed',
      message: `Vite is not installed for ${appRelative}.`,
    };
  }
  if (!versionAtLeast(viteVersion, '6.0.0')) {
    return {
      ok: false,
      status: 'vite_version_unsupported',
      message: `Installed Vite ${viteVersion} is below the supported floor 6.0.0.`,
    };
  }

  const sdkVersion = await versionReader(appDir, '@opslane/sdk');
  if (!sdkVersion) {
    return {
      ok: false,
      status: 'sdk_not_installed',
      message: '@opslane/sdk is not installed for this app.',
    };
  }
  if (
    contract.minimumSdkVersion === null
    || !versionAtLeast(sdkVersion, contract.minimumSdkVersion)
  ) {
    return {
      ok: false,
      status: 'plugin_not_available_yet',
      message: contract.minimumSdkVersion === null
        ? 'The zero-argument Opslane Vite plugin has not been published yet.'
        : `Installed @opslane/sdk ${sdkVersion} does not provide the required plugin (>=${contract.minimumSdkVersion}).`,
    };
  }

  return {
    ok: true,
    repoRoot: options.repoRoot,
    appDir,
    appRelative,
    configPath: snapshot.absolute,
    configRelative: snapshot.relative,
    snapshot,
    viteVersion,
    sdkVersion,
  };
}
