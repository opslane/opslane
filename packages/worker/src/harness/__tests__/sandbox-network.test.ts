import { describe, expect, it } from 'vitest';
import { ALL_TRAFFIC } from 'e2b';
import { buildReadOnlyNetwork } from '../sandbox-network.js';

describe('buildReadOnlyNetwork', () => {
  it('denies all traffic and allows exactly the three required hosts', () => {
    const net = buildReadOnlyNetwork('sk-ant-test');
    expect(net.denyOut).toEqual([ALL_TRAFFIC]);
    expect(net.allowOut).toEqual(['registry.npmjs.org', 'github.com', 'api.anthropic.com']);
  });

  it('injects the api key as a header rule so it never enters the sandbox', () => {
    const net = buildReadOnlyNetwork('sk-ant-test');
    expect(net.rules?.['api.anthropic.com']).toEqual([
      { transform: { headers: { 'x-api-key': 'sk-ant-test', 'anthropic-version': '2023-06-01' } } },
    ]);
  });

  it('registers no rule for hosts needing no credential', () => {
    const net = buildReadOnlyNetwork('sk-ant-test');
    expect(net.rules?.['github.com']).toBeUndefined();
    expect(net.rules?.['registry.npmjs.org']).toBeUndefined();
  });

  it('rejects an empty key rather than building a rule that injects nothing', () => {
    expect(() => buildReadOnlyNetwork('')).toThrow('Anthropic API key is required');
  });
});
