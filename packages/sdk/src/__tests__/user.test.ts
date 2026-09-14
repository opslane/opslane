import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildPayload, setUser, clearUser } from '../core';
import { loadConfig, resetConfig } from '../config';
import { clearBreadcrumbs } from '../breadcrumbs';
import { TEST_PK } from './test-keys';

describe('setUser / clearUser', () => {
  beforeEach(() => {
    resetConfig();
    clearBreadcrumbs();
    clearUser();
    loadConfig({
      endpoint: 'https://ingest.example.com',
      apiKey: TEST_PK,
    });
  });

  afterEach(() => {
    clearUser();
    resetConfig();
    clearBreadcrumbs();
  });

  it('buildPayload includes user context when setUser is called', () => {
    setUser({ id: 'u-123', email: 'alice@acme.com', account: { id: 'acme', name: 'Acme Corp' } });

    const payload = buildPayload('TypeError', 'test', 'stack', {
      type: 'error',
      timestamp: new Date().toISOString(),
      category: 'test',
      message: 'test',
    });

    expect(payload.context.user).toEqual({
      id: 'u-123',
      email: 'alice@acme.com',
      account_id: 'acme',
      account_name: 'Acme Corp',
    });
  });

  it('buildPayload omits user context when no user is set', () => {
    const payload = buildPayload('TypeError', 'test', 'stack', {
      type: 'error',
      timestamp: new Date().toISOString(),
      category: 'test',
      message: 'test',
    });

    expect(payload.context.user).toBeUndefined();
  });

  it('clearUser removes user context from subsequent payloads', () => {
    setUser({ id: 'u-123' });
    clearUser();

    const payload = buildPayload('TypeError', 'test', 'stack', {
      type: 'error',
      timestamp: new Date().toISOString(),
      category: 'test',
      message: 'test',
    });

    expect(payload.context.user).toBeUndefined();
  });

  it('setUser ignores empty id', () => {
    setUser({ id: '' });

    const payload = buildPayload('TypeError', 'test', 'stack', {
      type: 'error',
      timestamp: new Date().toISOString(),
      category: 'test',
      message: 'test',
    });

    expect(payload.context.user).toBeUndefined();
  });

  it('setUser works without optional fields', () => {
    setUser({ id: 'u-456' });

    const payload = buildPayload('TypeError', 'test', 'stack', {
      type: 'error',
      timestamp: new Date().toISOString(),
      category: 'test',
      message: 'test',
    });

    expect(payload.context.user).toEqual({
      id: 'u-456',
      email: undefined,
      account_id: undefined,
      account_name: undefined,
    });
  });

  const userOnNextPayload = () => buildPayload('TypeError', 'test', 'stack', {
    type: 'error',
    timestamp: new Date().toISOString(),
    category: 'test',
    message: 'test',
  }).context.user;

  it('sends numeric user and account IDs as strings', () => {
    setUser({ id: 42, account: { id: 7, name: 'Acme Corp' } });

    expect(userOnNextPayload()).toEqual({
      id: '42',
      email: undefined,
      account_id: '7',
      account_name: 'Acme Corp',
    });
  });

  it.each([
    [-1, '-1'],
    [Number.MAX_SAFE_INTEGER, '9007199254740991'],
    [12345678901234567890n, '12345678901234567890'],
  ])('sends integer id %s as %s', (input, expected) => {
    setUser({ id: input });
    expect(userOnNextPayload()?.id).toBe(expected);
  });

  it('ignores values that are not usable IDs', () => {
    for (const id of [0, 0n, 1.5, Number.MAX_SAFE_INTEGER + 2, 1e21, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, {}, true, '', 'undefined', 'null', 'x'.repeat(257)]) {
      setUser({ id } as never);
      expect(userOnNextPayload()).toBeUndefined();
    }
  });

  it('keeps the account name when the account ID is missing or invalid', () => {
    for (const id of [undefined, '', 1.5, Number.NaN, null, {}]) {
      setUser({ id: 'u-1', account: { id, name: 'Acme Corp' } } as never);
      expect(userOnNextPayload()).toEqual({
        id: 'u-1',
        email: undefined,
        account_id: undefined,
        account_name: 'Acme Corp',
      });
    }
  });

  it('drops an email or account name that is not a string or is oversized', () => {
    setUser({ id: 'u-1', email: 5, account: { id: 'a-1', name: { x: 1 } } } as never);
    expect(userOnNextPayload()).toEqual({ id: 'u-1', email: undefined, account_id: 'a-1', account_name: undefined });

    setUser({ id: 'u-1', email: `${'a'.repeat(511)}@x`, account: { id: 'a-1', name: 'n'.repeat(513) } });

    expect(userOnNextPayload()).toEqual({ id: 'u-1', email: undefined, account_id: 'a-1', account_name: undefined });
  });

  it('reflects later changes to the identity object', () => {
    const user: { id: string; email?: string } = { id: 'u-1' };
    setUser(user);
    user.email = 'alice@acme.com';

    expect(userOnNextPayload()?.email).toBe('alice@acme.com');
  });

  it('does not throw when called without an identity', () => {
    expect(() => setUser(undefined as never)).not.toThrow();
    expect(() => setUser(null as never)).not.toThrow();
    expect(userOnNextPayload()).toBeUndefined();
  });
});
