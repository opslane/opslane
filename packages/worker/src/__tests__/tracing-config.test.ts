import { describe, it, expect } from 'vitest';
import { resolveTracingConfig, normalizeBaseUrl, describeConfig } from '../tracing-config.js';

const KEYS = {
  LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
  LANGFUSE_SECRET_KEY: 'sk-lf-test',
};

describe('resolveTracingConfig', () => {
  it('returns disabled when no Langfuse variables are set', () => {
    expect(resolveTracingConfig({})).toEqual({ status: 'disabled' });
    expect(resolveTracingConfig({ PATH: '/usr/bin' })).toEqual({ status: 'disabled' });
  });

  it('returns incomplete when keys are set but the base URL is missing', () => {
    // This is the exact production failure this work exists to prevent.
    expect(resolveTracingConfig({ ...KEYS })).toEqual({
      status: 'incomplete',
      missing: ['LANGFUSE_BASE_URL'],
      invalid: [],
    });
  });

  it('treats empty and whitespace-only values as unset', () => {
    // Terraform emits "" for an unset variable.
    expect(resolveTracingConfig({ ...KEYS, LANGFUSE_BASE_URL: '' })).toEqual({
      status: 'incomplete',
      missing: ['LANGFUSE_BASE_URL'],
      invalid: [],
    });
    expect(resolveTracingConfig({ ...KEYS, LANGFUSE_BASE_URL: '   ' })).toEqual({
      status: 'incomplete',
      missing: ['LANGFUSE_BASE_URL'],
      invalid: [],
    });
  });

  it('reports a malformed base URL as invalid rather than missing', () => {
    for (const bad of ['ftp://example.com', 'not a url', 'https://user:pw@example.com']) {
      expect(resolveTracingConfig({ ...KEYS, LANGFUSE_BASE_URL: bad })).toEqual({
        status: 'incomplete',
        missing: [],
        invalid: ['LANGFUSE_BASE_URL'],
      });
    }
  });

  it('lists every missing delivery variable when only the project id is set', () => {
    expect(resolveTracingConfig({ LANGFUSE_PROJECT_ID: 'proj-1' })).toEqual({
      status: 'incomplete',
      missing: ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_BASE_URL'],
      invalid: [],
    });
  });

  it('returns enabled with a null project id when only the trio is set', () => {
    expect(
      resolveTracingConfig({ ...KEYS, LANGFUSE_BASE_URL: 'https://us.cloud.langfuse.com' }),
    ).toEqual({
      status: 'enabled',
      baseUrl: 'https://us.cloud.langfuse.com',
      projectId: null,
      credentials: { publicKey: 'pk-lf-test', secretKey: 'sk-lf-test' },
    });
  });

  it('treats a whitespace-only project id as absent', () => {
    expect(
      resolveTracingConfig({
        ...KEYS,
        LANGFUSE_BASE_URL: 'https://us.cloud.langfuse.com',
        LANGFUSE_PROJECT_ID: '   ',
      }),
    ).toMatchObject({ status: 'enabled', projectId: null });
  });

  it('returns enabled with both values when all four are set', () => {
    expect(
      resolveTracingConfig({
        ...KEYS,
        LANGFUSE_BASE_URL: 'https://us.cloud.langfuse.com',
        LANGFUSE_PROJECT_ID: 'proj-1',
      }),
    ).toMatchObject({ status: 'enabled', projectId: 'proj-1' });
  });
});

describe('normalizeBaseUrl', () => {
  it('strips trailing slashes, query, and fragment', () => {
    expect(normalizeBaseUrl('https://us.cloud.langfuse.com/')).toBe('https://us.cloud.langfuse.com');
    expect(normalizeBaseUrl('https://example.com/base/')).toBe('https://example.com/base');
    expect(normalizeBaseUrl('https://example.com/?a=1#frag')).toBe('https://example.com');
  });

  it('rejects non-http protocols, junk, and embedded credentials', () => {
    expect(normalizeBaseUrl('ftp://example.com')).toBeNull();
    expect(normalizeBaseUrl('not a url')).toBeNull();
    expect(normalizeBaseUrl('https://user:pw@example.com')).toBeNull();
  });

  it('accepts plain http', () => {
    expect(normalizeBaseUrl('http://localhost:3000')).toBe('http://localhost:3000');
  });
});

describe('describeConfig', () => {
  it('never exposes credentials', () => {
    const described = describeConfig(
      resolveTracingConfig({
        ...KEYS,
        LANGFUSE_BASE_URL: 'https://us.cloud.langfuse.com',
        LANGFUSE_PROJECT_ID: 'proj-1',
      }),
    );
    expect(described).toEqual({
      status: 'enabled',
      host: 'https://us.cloud.langfuse.com',
      has_project_id: true,
    });
    expect(JSON.stringify(described)).not.toContain('sk-lf-test');
    expect(JSON.stringify(described)).not.toContain('pk-lf-test');
  });

  it('reports the missing and invalid lists for an incomplete config', () => {
    expect(describeConfig(resolveTracingConfig({ ...KEYS }))).toEqual({
      status: 'incomplete',
      missing: ['LANGFUSE_BASE_URL'],
      invalid: [],
    });
  });
});
