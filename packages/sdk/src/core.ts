import type { ErrorEventPayload, Breadcrumb } from '@opslane/shared';
import { getConfig } from './config';
import { addBreadcrumb, getBreadcrumbs } from './breadcrumbs';
import { enqueueEvent } from './transport';
import { getSessionId, getSessionProgress, setSessionUser, type SessionProgress } from './session.js';
import { SDK_VERSION } from './version';
import { COMMIT_SHA_GLOBAL } from './build/registry-contract.js';

declare const __OPSLANE_COMMIT_SHA__: string;

let installed = false;

// === B2B user identity ===

interface UserIdentity {
  id: string;
  email?: string;
  account?: { id: string; name?: string };
}

let currentUser: UserIdentity | null = null;

type IdentityListener = (newSessionID: string, previous: SessionProgress) => void;
let identityListener: IdentityListener | null = null;

export function onIdentityChange(listener: IdentityListener | null): void {
  identityListener = listener;
}

function rotateForIdentity(userId: string | null): void {
  const previous = getSessionProgress();
  if (!setSessionUser(userId)) return;
  try {
    identityListener?.(getSessionId(), previous);
  } catch {
    // SDK must never throw.
  }
}

export function setUser(user: UserIdentity): void {
  if (!user.id) return;
  currentUser = user;
  rotateForIdentity(user.id);
}

export function clearUser(): void {
  currentUser = null;
  rotateForIdentity(null);
}

export function getCurrentUser(): UserIdentity | null {
  return currentUser;
}

/** Map UserIdentity to the wire-format user context object. */
export function buildUserContext(user: UserIdentity): NonNullable<ErrorEventPayload['context']['user']> {
  return {
    id: user.id,
    email: user.email,
    account_id: user.account?.id,
    account_name: user.account?.name,
  };
}

export function buildPayload(
  errorType: string,
  errorMessage: string,
  stack: string,
  breadcrumb: Breadcrumb
): ErrorEventPayload {
  const config = getConfig();

  addBreadcrumb(breadcrumb);

  const context: ErrorEventPayload['context'] = {
    url: typeof window !== 'undefined' ? window.location.href : '',
    user_agent:
      typeof navigator !== 'undefined' ? navigator.userAgent : '',
  };
  if (currentUser) {
    context.user = buildUserContext(currentUser);
  }

  return {
    timestamp: new Date().toISOString(),
    error: {
      type: errorType,
      message: errorMessage,
      stack,
    },
    breadcrumbs: getBreadcrumbs(),
    context,
    sdk_version: SDK_VERSION,
    release: config.release || undefined,
    commit_sha: readCommitSha(),
    session_id: getSessionId() || undefined,
    environment: config.environment || undefined,
  };
}

function readCommitSha(): string | undefined {
  const injected =
    typeof __OPSLANE_COMMIT_SHA__ !== 'undefined'
      ? __OPSLANE_COMMIT_SHA__
      : (globalThis as Record<string, unknown>)[COMMIT_SHA_GLOBAL];
  return typeof injected === 'string' &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(injected)
    ? injected
    : undefined;
}

function handleError(event: ErrorEvent): void {
  try {
    const { errorType, errorMessage, stack } = normalizeError(event.error, event.message || undefined, 'Error');
    const payload = buildPayload(errorType, errorMessage, stack, errorBreadcrumb(errorType, errorMessage));
    enqueueEvent(payload, 'uncaught_error');
  } catch (_e) {
    // SDK must never throw into the customer's app
  }
}

function handleUnhandledRejection(event: PromiseRejectionEvent): void {
  try {
    const { errorType, errorMessage, stack } = normalizeError(event.reason, undefined, 'UnhandledRejection');
    const payload = buildPayload(errorType, errorMessage, stack, errorBreadcrumb(errorType, errorMessage));
    enqueueEvent(payload, 'uncaught_error');
  } catch (_e) {
    // SDK must never throw into the customer's app
  }
}

function errorBreadcrumb(errorType: string, errorMessage: string): Breadcrumb {
  return {
    type: 'error',
    timestamp: new Date().toISOString(),
    category: 'exception',
    message: `${errorType}: ${errorMessage}`,
    level: 'error',
  };
}

/** Every real stack frame ends in `:line:column`, optionally closed by a paren. */
const FRAME_TAIL = /:\d+:\d+\)?$/;
/** A dotted filename, e.g. `index.js`. Fixed width, so it cannot backtrack. */
const DOTTED_NAME = /\w\.\w/;

/** Check whether a stack string contains at least one user-code frame (at file:line:col). */
function hasUserFrames(stack: string): boolean {
  // Matched per line against an end-anchored pattern, which is what keeps this
  // linear. Scanning the whole stack with a leading `.*` or `[^\s]+` in front
  // of the position pair backtracks quadratically, and a stack carries the
  // error message, which routinely holds text the page did not author. A
  // regex that stalls here freezes the customer's main thread, which is worse
  // than the exception we were called to report.
  for (const raw of stack.split('\n')) {
    const line = raw.trim();
    if (!FRAME_TAIL.test(line)) continue;
    // V8 writes "at fn (url:line:column)"; Firefox and WebKit write
    // "fn@url:line:column". The dot keeps a V8 frame to ones naming a file,
    // matching what this checked before; DOTTED_NAME is fixed-width and cannot
    // backtrack, so it does not reintroduce the problem.
    if (line.startsWith('at ') && DOTTED_NAME.test(line)) return true;
    if (line.includes('@')) return true;
  }
  return false;
}

function normalizeError(input: unknown, fallbackMessage?: string, fallbackType = 'Error'): {
  errorType: string;
  errorMessage: string;
  stack: string;
} {
  if (input instanceof Error) {
    let stack = input.stack || '';

    // Browser-internal errors (e.g. SyntaxError from JSON.parse) often have
    // no user-code frames. Capture a synthetic stack at the catch point so
    // the worker can identify which component triggered the error.
    if (!hasUserFrames(stack)) {
      const synthetic = new Error('__opslane_synthetic__').stack || '';
      // Append synthetic frames (skip the first line which is our marker)
      const syntheticFrames = synthetic.split('\n').slice(1).join('\n');
      if (syntheticFrames) {
        stack = stack ? `${stack}\n    --- synthetic caller stack ---\n${syntheticFrames}` : syntheticFrames;
      }
    }

    return {
      errorType: input.constructor.name || fallbackType,
      errorMessage: input.message,
      stack,
    };
  }

  return {
    errorType: fallbackType,
    errorMessage: fallbackMessage || String(input),
    stack: '',
  };
}

export function captureException(input: unknown): void {
  try {
    const { errorType, errorMessage, stack } = normalizeError(input, undefined, 'CapturedException');
    const payload = buildPayload(errorType, errorMessage, stack, errorBreadcrumb(errorType, errorMessage));
    enqueueEvent(payload, 'capture_exception');
  } catch {
    // SDK must never throw into the customer's app
  }
}

export function installGlobalHandlers(): void {
  if (installed) return;
  installed = true;

  window.addEventListener('error', handleError);
  window.addEventListener('unhandledrejection', handleUnhandledRejection);
}

export function uninstallGlobalHandlers(): void {
  if (!installed) return;
  installed = false;

  window.removeEventListener('error', handleError);
  window.removeEventListener('unhandledrejection', handleUnhandledRejection);
}
