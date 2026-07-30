/**
 * The exact text this tool inserts, and the exact shape verification accepts.
 * #224 owns the plugin. When it renames the export or the subpath, it must
 * change this file, and the drift test below fails until it does.
 */
export const OPSLANE_VITE_PLUGIN = {
  specifier: '@opslane/sdk/vite-plugin',
  exportName: 'opslane',
  pluginName: 'opslane-source-map',
  importLine: "import { opslane } from '@opslane/sdk/vite-plugin';",
  callText: 'opslane()',
} as const;

/**
 * This is distinct from OPSLANE_IDENTITY_MIN_VERSION. A lockfile pinned to
 * 2.0.1 satisfies the SDK identity floor but still has no opslane() factory.
 * Set this when #224 publishes.
 */
export const OPSLANE_VITE_PLUGIN_MIN_VERSION: string | null = null;

export interface PluginContractDeps {
  specifier: string;
  exportName: string;
  pluginName: string;
  importLine: string;
  callText: string;
  minimumSdkVersion: string | null;
}

export const DEFAULT_PLUGIN_CONTRACT: PluginContractDeps = {
  ...OPSLANE_VITE_PLUGIN,
  minimumSdkVersion: OPSLANE_VITE_PLUGIN_MIN_VERSION,
};

