import { afterEach, describe, expect, it } from 'vitest';

import { buildGitNetrc, buildRepoUrl } from '../repo-url.js';

describe('buildRepoUrl', () => {
  const originalBaseUrl = process.env['OPSLANE_GITHUB_URL'];

  afterEach(() => {
    if (originalBaseUrl === undefined) delete process.env['OPSLANE_GITHUB_URL'];
    else process.env['OPSLANE_GITHUB_URL'] = originalBaseUrl;
  });

  it('uses the public GitHub transport by default', () => {
    delete process.env['OPSLANE_GITHUB_URL'];
    expect(buildRepoUrl('owner/repo')).toBe('https://github.com/owner/repo.git');
  });

  it('treats an empty Compose value as the default GitHub transport', () => {
    process.env['OPSLANE_GITHUB_URL'] = '   ';
    expect(buildRepoUrl('owner/repo')).toBe('https://github.com/owner/repo.git');
  });

  it('targets a local bare-repository root without embedding credentials', () => {
    process.env['OPSLANE_GITHUB_URL'] = 'file:///tmp/opslane-remotes';
    expect(buildRepoUrl('owner/repo', 'ignored-for-file-transport')).toBe(
      'file:///tmp/opslane-remotes/owner/repo.git',
    );
  });

  it('embeds credentials only for host-side HTTP clones', () => {
    process.env['OPSLANE_GITHUB_URL'] = 'https://git.example.test/base';
    expect(buildRepoUrl('owner/repo')).toBe(
      'https://git.example.test/base/owner/repo.git',
    );
    expect(buildRepoUrl('owner/repo', 'test-token')).toBe(
      'https://x-access-token:test-token@git.example.test/base/owner/repo.git',
    );
  });

  it('rejects repositories that are not strict owner/repo', () => {
    process.env['OPSLANE_GITHUB_URL'] = 'file:///tmp/opslane-remotes';
    for (const bad of ['../repo', 'owner/..', '../../etc/target', 'owner/repo/extra', 'ownerrepo', '']) {
      expect(() => buildRepoUrl(bad, 'token')).toThrow(/Invalid github_repo/);
    }
  });
});

describe('buildGitNetrc', () => {
  it('targets the configured HTTP host instead of hard-coding github.com', () => {
    expect(
      buildGitNetrc('https://ghe.example.test/acme/app.git', 'test-token'),
    ).toBe(
      'machine ghe.example.test\nlogin x-access-token\npassword test-token\n',
    );
  });

  it('does not create HTTP credentials for local file transports', () => {
    expect(buildGitNetrc('file:///tmp/remotes/acme/app.git', 'test-token')).toBeNull();
  });

  it('rejects tokens that could inject additional netrc entries', () => {
    expect(() =>
      buildGitNetrc(
        'https://ghe.example.test/acme/app.git',
        'token\nmachine attacker.invalid',
      ),
    ).toThrow(/invalid git credential/i);
  });
});
