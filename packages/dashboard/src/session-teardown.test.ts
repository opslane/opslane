// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { clearClientSession } from './session';
import { ENVIRONMENT_STORAGE_KEY } from './composables/useEnvironmentFilter';

/**
 * Sign-out must leave no tenant-scoped state behind. A surviving
 * `opslane_environment_id` is re-applied as an `environment_id` query param
 * under the next user's session on a shared browser.
 */
describe('clearClientSession', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('removes every opslane_* key written anywhere in the app', () => {
    localStorage.setItem('opslane_authed', '1');
    localStorage.setItem('opslane_project_id', 'project-1');
    localStorage.setItem('opslane_project_name', 'Acme');
    localStorage.setItem(ENVIRONMENT_STORAGE_KEY, 'env-1');
    localStorage.setItem(`${ENVIRONMENT_STORAGE_KEY}:project-1`, 'env-2');
    localStorage.setItem(`${ENVIRONMENT_STORAGE_KEY}:project-2`, '__all__');
    sessionStorage.setItem('opslane_post_auth_path', '/invite/accept?token=secret');

    clearClientSession();

    const leftover = [
      ...Object.keys(localStorage),
      ...Object.keys(sessionStorage),
    ].filter((key) => key.startsWith('opslane_'));
    expect(leftover).toEqual([]);
  });

  it('clears the legacy pre-cookie token keys', () => {
    localStorage.setItem('defender_access_token', 'a');
    localStorage.setItem('defender_refresh_token', 'b');
    localStorage.setItem('defender_token_expires_at', 'c');

    clearClientSession();

    expect(Object.keys(localStorage).filter((key) => key.startsWith('defender_'))).toEqual([]);
  });

  it('keeps the inlined environment key in sync with its source of truth', () => {
    // api.ts spells this key out to avoid an import cycle; if the constant is
    // ever renamed, this fails instead of silently leaking the old key.
    expect(ENVIRONMENT_STORAGE_KEY).toBe('opslane_environment_id');
  });
});
