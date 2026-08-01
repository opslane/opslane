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
 * Vite majors the plugin declares support for, mirroring its peerDependencies.
 * The ceiling keeps us from installing into a future major the plugin has never
 * been built against, which would move the failure out of this command and into
 * the customer's build. The floor is 5 because the plugin supports it and 23 of
 * the 58 measured real configs are on it; Vite 5's CommonJS build hides
 * resolveConfig behind `default`, which the resolver already unwraps.
 */
export const SUPPORTED_VITE_MAJORS = { minimum: 5, maximum: 8 } as const;

/**
 * This is distinct from OPSLANE_IDENTITY_MIN_VERSION. Published 2.0.1 satisfies
 * the SDK identity floor but has no opslane() factory: the factory lands in the
 * next release, which the queued changesets make a major, so 3.0.0. Anything
 * below this resolves the import to a package that cannot provide the plugin.
 */
export const OPSLANE_VITE_PLUGIN_MIN_VERSION: string | null = '3.0.0';

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
