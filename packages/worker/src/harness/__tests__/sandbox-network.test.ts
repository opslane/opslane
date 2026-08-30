import { describe, expect, it } from 'vitest';
import { ALL_TRAFFIC } from 'e2b';
import { buildReadOnlyNetwork } from '../sandbox-network.js';

const REPO = 'https://github.com/acme/app.git';

describe('buildReadOnlyNetwork', () => {
  it('denies all traffic and allows the git host plus the two fixed hosts', () => {
    const net = buildReadOnlyNetwork('sk-ant-test', REPO);
    expect(net.denyOut).toEqual([ALL_TRAFFIC]);
    expect(net.allowOut).toEqual(['github.com', 'registry.npmjs.org', 'api.anthropic.com']);
  });

  it('allows the configured git host, not a hardcoded github.com', () => {
    // OPSLANE_GITHUB_URL makes the clone host configurable. Hardcoding
    // github.com meant a self-hosted install cloned into a machine whose
    // deny-all policy blocked the only host the clone needed.
    const net = buildReadOnlyNetwork('sk-ant-test', 'https://git.internal.acme.dev/acme/app.git');
    expect(net.allowOut).toContain('git.internal.acme.dev');
    expect(net.allowOut).not.toContain('github.com');
  });

  it('does not list the git host twice when it is already an allowed host', () => {
    const net = buildReadOnlyNetwork('sk-ant-test', 'https://registry.npmjs.org/acme/app.git');
    expect(net.allowOut).toEqual(['registry.npmjs.org', 'api.anthropic.com']);
  });

  it('injects the api key as a header rule so it never enters the sandbox', () => {
    const net = buildReadOnlyNetwork('sk-ant-test', REPO);
    expect(net.rules?.['api.anthropic.com']).toEqual([
      { transform: { headers: { 'x-api-key': 'sk-ant-test', 'anthropic-version': '2023-06-01' } } },
    ]);
  });

  it('registers no rule for hosts needing no credential', () => {
    const net = buildReadOnlyNetwork('sk-ant-test', REPO);
    expect(net.rules?.['github.com']).toBeUndefined();
    expect(net.rules?.['registry.npmjs.org']).toBeUndefined();
  });

  it('rejects an empty key rather than building a rule that injects nothing', () => {
    expect(() => buildReadOnlyNetwork('', REPO)).toThrow('Anthropic API key is required');
  });

  it('rejects a clone URL it cannot read a host from, rather than allowing nothing', () => {
    expect(() => buildReadOnlyNetwork('sk-ant-test', 'not-a-url')).toThrow('clone URL is required');
  });

  it('allows no extra host for a file:// remote, which needs no egress', () => {
    // The local verify rigs clone a twin repository off the filesystem. A
    // file:// URL has an empty hostname, and treating that as unreadable failed
    // every rig with "a clone URL is required" before the machine even started.
    const net = buildReadOnlyNetwork('sk-ant-test', 'file:///tmp/remotes/acme/app.git');
    expect(net.allowOut).toEqual(['registry.npmjs.org', 'api.anthropic.com']);
    expect(net.denyOut).toEqual([ALL_TRAFFIC]);
  });
});
