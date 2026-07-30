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
});
