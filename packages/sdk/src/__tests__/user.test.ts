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

  it('ignores IDs that are neither strings nor finite numbers', () => {
    for (const id of [Number.NaN, Number.POSITIVE_INFINITY, null, undefined, {}, true]) {
      setUser({ id } as never);
      expect(userOnNextPayload()).toBeUndefined();
    }
  });

  it('drops an account whose ID is missing or invalid but keeps the user', () => {
    setUser({ id: 'u-1', account: { id: '', name: 'Acme Corp' } });

    expect(userOnNextPayload()).toEqual({
      id: 'u-1',
      email: undefined,
      account_id: undefined,
      account_name: undefined,
    });
  });

  it('does not throw when called without an identity', () => {
    expect(() => setUser(undefined as never)).not.toThrow();
    expect(userOnNextPayload()).toBeUndefined();
  });
});
