import { clearAuth } from './api';

/**
 * Every tenant-scoped key this app persists, in one place.
 *
 * Sign-out must clear all of them. `clearAuth()` only removes the auth hint and
 * the legacy pre-cookie token keys, so before this existed a sign-out left the
 * project id/name and the selected environment id behind. On a shared browser
 * the surviving environment id is re-applied as an `environment_id` query param
 * under the *next* user's session.
 *
 * The environment key is spelled out rather than imported from
 * composables/useEnvironmentFilter.ts because that module imports from ./api,
 * and this module does too — importing it here would close a cycle.
 * session-teardown.test.ts asserts the literal matches the exported constant.
 *
 * This lives outside api.ts because api.ts was frozen during the design-system
 * migration. That freeze has since been retired; the split is kept because the
 * cycle note above still applies.
 */
const TENANT_LOCAL_KEYS = [
  'opslane_project_id',
  'opslane_project_name',
  'opslane_environment_id',
] as const;

const TENANT_SESSION_KEYS = ['opslane_post_auth_path'] as const;

/** Clears auth plus all tenant-scoped client state. Use on sign-out. */
export function clearClientSession(): void {
  clearAuth();
  for (const key of TENANT_LOCAL_KEYS) localStorage.removeItem(key);
  // Environment choices are stored per project ('opslane_environment_id:<id>');
  // sweep the prefix so no project's filter survives to the next user.
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith('opslane_environment_id:')) localStorage.removeItem(key);
  }
  for (const key of TENANT_SESSION_KEYS) sessionStorage.removeItem(key);
}
