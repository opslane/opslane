/** Global the plugin writes and the SDK reads. Frozen: changing it breaks old builds. */
export const REGISTRY_GLOBAL = '__OPSLANE_DEBUG_IDS__';

/** Compile-time constant the plugin defines and the SDK reads for build provenance. */
export const COMMIT_SHA_GLOBAL = '__OPSLANE_COMMIT_SHA__';

/** Exact sentinel the plugin emits and then substitutes. It matches a debug ID's width. */
export const DEBUG_ID_PLACEHOLDER = '0PSLANE-P14C3-H01D-3R00-000000000000';

/** Module URL to every distinct debug ID registered for that URL. */
export type DebugIdRegistry = Record<string, string[]>;
