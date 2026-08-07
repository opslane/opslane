import type { SdkInitOptions } from './config';
import { InvalidApiKeyError, loadConfig, resetConfig } from './config';
import { captureException, installGlobalHandlers, onIdentityChange, uninstallGlobalHandlers, setUser, clearUser } from './core';
import { patchConsole, unpatchConsole } from './console';
import { patchFetch, unpatchFetch, patchXHR, unpatchXHR } from './network';
import { startTransport, stopTransport } from './transport';
import { clearBreadcrumbs } from './breadcrumbs';
import { registerSession, resetSessionRegistrations, startReplayCapture, stopReplayCapture } from './replay';
import { ensureSessionID } from './session.js';
import { installInteractionTelemetry, uninstallInteractionTelemetry } from './telemetry';
import { clearNetworkTimings } from './network-timing';

export { opslaneVuePlugin } from './vue';
export type { SdkInitOptions } from './config';
export { captureException, setUser, clearUser };

let initialized = false;

/** Run a function, swallowing any error so the SDK never throws into user code. */
function safeCall(fn: () => void): void {
  try { fn(); } catch { /* SDK must never throw */ }
}

export function init(options: SdkInitOptions): void {
  if (initialized) return;

  try {
    loadConfig(options);
  } catch (e) {
    if (e instanceof InvalidApiKeyError) {
      // A wrong key type means the app can never report errors, or a secret
      // may have been shipped in browser code. Surface it even without debug.
      console.error(e.message);
      return;
    }
    if (options.debug) {
      console.error('[opslane] init failed:', e);
    }
    return;
  }

  initialized = true;

  safeCall(installGlobalHandlers);
  safeCall(patchConsole);
  safeCall(patchFetch);
  safeCall(patchXHR);
  safeCall(installInteractionTelemetry);
  safeCall(startTransport);
  safeCall(ensureSessionID);
  safeCall(() => { void registerSession().catch(() => {}); });
  safeCall(() => { void startReplayCapture().catch(() => {}); });
}

export function destroy(): void {
  if (!initialized) return;
  initialized = false;

  safeCall(uninstallGlobalHandlers);
  safeCall(unpatchConsole);
  safeCall(unpatchFetch);
  safeCall(unpatchXHR);
  safeCall(uninstallInteractionTelemetry);
  safeCall(stopTransport);
  safeCall(stopReplayCapture);
  safeCall(resetSessionRegistrations);
  safeCall(clearBreadcrumbs);
  safeCall(clearNetworkTimings);
  safeCall(() => onIdentityChange(null));
  safeCall(clearUser);
  safeCall(resetConfig);
}

// Namespace export for OpslaneSDK.init() pattern
export const OpslaneSDK = {
  init,
  destroy,
  captureException,
  setUser,
  clearUser,
};

// Alias for shorter import: import { Opslane } from '@opslane/sdk'
export { OpslaneSDK as Opslane };
