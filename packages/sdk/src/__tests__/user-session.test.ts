import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearUser, getCurrentUser, onIdentityChange, setUser } from '../core';
import { ensureSessionID, getSessionId, resetSessionId } from '../session';
import { loadConfig, resetConfig } from '../config';
import { TEST_PK } from './test-keys';

describe('setUser session rotation', () => {
  beforeEach(() => {
    sessionStorage.clear();
    resetSessionId();
    resetConfig();
    onIdentityChange(null);
    clearUser();
    loadConfig({ apiKey: TEST_PK, endpoint: 'https://x.example.com' });
  });

  it('rotates the session id when identity changes', () => {
    const anon = ensureSessionID();
    setUser({ id: 'alice' });
    expect(getSessionId()).not.toBe(anon);
  });

  it('does not rotate when the same user is set twice', () => {
    setUser({ id: 'alice' });
    const first = getSessionId();
    setUser({ id: 'alice', email: 'alice@example.com' });
    expect(getSessionId()).toBe(first);
  });

  it('rotates on logout', () => {
    setUser({ id: 'alice' });
    const alice = getSessionId();
    clearUser();
    expect(getSessionId()).not.toBe(alice);
  });

  it('notifies the identity-change listener with the new session', () => {
    const listener = vi.fn();
    onIdentityChange(listener);
    setUser({ id: 'alice' });
    expect(listener).toHaveBeenCalledWith(
      getSessionId(),
      expect.objectContaining({ id: expect.any(String), nextSeq: 0 }),
    );
    setUser({ id: 'alice' });
    expect(listener).toHaveBeenCalledTimes(1);
    clearUser();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('still records identity for error payloads', () => {
    setUser({ id: 'alice', email: 'a@example.com', account: { id: 'acct-1' } });
    expect(getCurrentUser()?.id).toBe('alice');
    clearUser();
    expect(getCurrentUser()).toBeNull();
  });
});
