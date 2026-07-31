/**
 * The exact text this tool inserts, and the exact shape verification accepts.
 * #224 owns the plugin. When it renames the export or the subpath, it must
 * change this file, and the drift test fails until it does.
 */
export const OPSLANE_VITE_PLUGIN = {
  specifier: '@opslane/sdk/vite-plugin',
  exportName: 'opslane',
  /**
   * The `name` the resolved plugin reports, which is the only evidence
   * verification has. Deliberately not `opslane-source-map`: that name belongs
   * to the deprecated uploader, which now throws on load, so reusing it would
   * make a working install and a broken one indistinguishable in the resolved
   * plugin list.
   */
  pluginName: 'opslane-debug-ids',
  importLine: "import { opslane } from '@opslane/sdk/vite-plugin';",
  callText: 'opslane()',
} as const;

/**
 * Names the SDK exports for the same current factory. A config importing any of
 * them is already on the supported plugin, so it must not be mistaken for the
 * legacy one. `opslaneSourceMapPlugin` is deliberately absent: that is the
 * deprecated uploader and importing it is what `legacy_opslane_plugin` means.
 */
export const OPSLANE_VITE_PLUGIN_EXPORT_NAMES = [
  'opslane',
  'opslaneVitePlugin',
] as const;

/**
 * Vite majors the plugin declares support for. The floor keeps us off versions
 * whose config module shape the resolver cannot use; the ceiling keeps us from
 * accepting a future major the plugin has never been built against, which would
 * otherwise be installed and fail in the customer's build instead of here.
 */
export const SUPPORTED_VITE_MAJORS = { minimum: 6, maximum: 8 } as const;

/**
 * This is distinct from OPSLANE_IDENTITY_MIN_VERSION. A lockfile pinned to
 * 2.0.1 satisfies the SDK identity floor but still has no opslane() factory.
 * Set this to the version that actually publishes the factory; the pending SDK
 * changeset is a major, so it will not be 2.1.0.
 */
export const OPSLANE_VITE_PLUGIN_MIN_VERSION: string | null = null;

export interface PluginContractDeps {
  specifier: string;
  exportName: string;
  /** Every current name for the factory, including `exportName`. */
  exportNames: readonly string[];
  pluginName: string;
  importLine: string;
  callText: string;
  minimumSdkVersion: string | null;
  viteMajors: { minimum: number; maximum: number };
}

export const DEFAULT_PLUGIN_CONTRACT: PluginContractDeps = {
  ...OPSLANE_VITE_PLUGIN,
  exportNames: OPSLANE_VITE_PLUGIN_EXPORT_NAMES,
  minimumSdkVersion: OPSLANE_VITE_PLUGIN_MIN_VERSION,
  viteMajors: SUPPORTED_VITE_MAJORS,
};
