import { describe, expect, it } from 'vitest';
import { optionalEnvMissing, requiredEnvMissing } from '../startup-env.js';

const base = { DATABASE_URL: 'postgres://x', ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 't' };

describe('requiredEnvMissing', () => {
  it('always requires DATABASE_URL', () => {
    expect(requiredEnvMissing({})).toContain('DATABASE_URL');
  });

  it('requires the JavaScript template once an E2B key is set on the default backend', () => {
    expect(requiredEnvMissing({ ...base, E2B_API_KEY: 'e2b' }))
      .toEqual(['OPSLANE_E2B_JAVASCRIPT_TEMPLATE']);
    expect(requiredEnvMissing({ ...base, E2B_API_KEY: 'e2b', OPSLANE_SANDBOX_BACKEND: 'e2b' }))
      .toEqual(['OPSLANE_E2B_JAVASCRIPT_TEMPLATE']);
  });

  it('treats an empty Compose interpolation as missing', () => {
    expect(requiredEnvMissing({
      ...base, E2B_API_KEY: 'e2b', OPSLANE_E2B_JAVASCRIPT_TEMPLATE: '',
    })).toEqual(['OPSLANE_E2B_JAVASCRIPT_TEMPLATE']);
    expect(requiredEnvMissing({
      ...base, E2B_API_KEY: 'e2b', OPSLANE_E2B_JAVASCRIPT_TEMPLATE: '  ',
    })).toEqual(['OPSLANE_E2B_JAVASCRIPT_TEMPLATE']);
  });

  it('keeps a stack without any E2B key starting, and the local backend too', () => {
    expect(requiredEnvMissing(base)).toEqual([]);
    expect(requiredEnvMissing({
      ...base, E2B_API_KEY: '', OPSLANE_E2B_JAVASCRIPT_TEMPLATE: '',
    })).toEqual([]);
    expect(requiredEnvMissing({
      ...base, E2B_API_KEY: 'e2b', OPSLANE_SANDBOX_BACKEND: 'local',
    })).toEqual([]);
  });
});

describe('optionalEnvMissing', () => {
  it('lists the keys whose absence only fails the jobs that need them', () => {
    expect(optionalEnvMissing({ DATABASE_URL: 'x' }))
      .toEqual(['ANTHROPIC_API_KEY', 'E2B_API_KEY', 'GITHUB_TOKEN']);
  });
});
