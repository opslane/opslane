import { describe, expect, it } from 'vitest';
import { ALL_TRAFFIC } from 'e2b';
import { buildFixNetwork, buildReadOnlyNetwork } from '../sandbox-network.js';

const REPO = 'https://github.com/acme/app.git';

describe('buildReadOnlyNetwork', () => {
  it('denies all traffic and allows only the git host and registry', () => {
    const net = buildReadOnlyNetwork(REPO);
    expect(net.denyOut).toEqual([ALL_TRAFFIC]);
    expect(net.allowOut).toEqual(['github.com', 'registry.npmjs.org']);
  });

  it('allows the configured git host, not a hardcoded github.com', () => {
    const net = buildReadOnlyNetwork('https://git.internal.acme.dev/acme/app.git');
    expect(net.allowOut).toContain('git.internal.acme.dev');
    expect(net.allowOut).not.toContain('github.com');
  });

  it('does not list the git host twice', () => {
    expect(buildReadOnlyNetwork('https://registry.npmjs.org/acme/app.git').allowOut)
      .toEqual(['registry.npmjs.org']);
  });

  it('does not let the machine reach Anthropic or inject a credential', () => {
    const net = buildReadOnlyNetwork(REPO);
    expect(net.allowOut).not.toContain('api.anthropic.com');
    expect(net.rules).toEqual({});
  });

  it('rejects a clone URL it cannot read', () => {
    expect(() => buildReadOnlyNetwork('not-a-url')).toThrow('clone URL is required');
  });

  it('allows no extra host for a file remote', () => {
    expect(buildReadOnlyNetwork('file:///tmp/remotes/acme/app.git').allowOut)
      .toEqual(['registry.npmjs.org']);
  });
});

describe('buildFixNetwork', () => {
  it('denies everything by default', () => {
    expect(buildFixNetwork('javascript', REPO).denyOut).toEqual([ALL_TRAFFIC]);
  });

  it('allows the configured git host, not a hardcoded github.com', () => {
    const allow = buildFixNetwork('javascript', 'https://git.internal.acme.dev/acme/app.git').allowOut;
    expect(allow).toContain('git.internal.acme.dev');
  });

  it('needs no extra host for a file:// remote, which the local rigs clone', () => {
    const net = buildFixNetwork('javascript', 'file:///tmp/twin/acme/app.git');
    expect(net.allowOut).toEqual(['registry.npmjs.org', 'nodejs.org',
      'github.com', 'codeload.github.com', 'raw.githubusercontent.com',
      'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
  });

  it('refuses a clone URL it cannot parse rather than silently blocking the clone', () => {
    expect(() => buildFixNetwork('javascript', 'not a url')).toThrow(/clone URL/);
  });

  it('names an enterprise host once, not twice', () => {
    const allow = buildFixNetwork('javascript', 'https://github.com/acme/app.git').allowOut;
    expect(allow.filter((host) => host === 'github.com')).toHaveLength(1);
  });

  it('allows the GitHub hosts a clone and release asset use', () => {
    const allow = buildFixNetwork('javascript', REPO).allowOut;
    for (const host of [
      'github.com', 'codeload.github.com', 'objects.githubusercontent.com',
      'raw.githubusercontent.com', 'release-assets.githubusercontent.com',
    ]) expect(allow).toContain(host);
  });

  it('allows the registry and Node header host node-gyp needs', () => {
    const allow = buildFixNetwork('javascript', REPO).allowOut;
    expect(allow).toContain('registry.npmjs.org');
    expect(allow).toContain('nodejs.org');
  });

  it('injects no credential and cannot reach Anthropic', () => {
    const net = buildFixNetwork('javascript', REPO);
    expect(net.rules).toEqual({});
    expect(net.allowOut).not.toContain('api.anthropic.com');
  });
});
