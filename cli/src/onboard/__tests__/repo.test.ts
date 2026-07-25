import { describe, expect, it } from 'vitest';
import { resolveRepo } from '../repo.js';

describe('resolveRepo', () => {
  it('prefers an explicit --repo over git detection', () => {
    expect(resolveRepo({ repo: 'acme/web', detect: () => 'other/repo' }))
      .toEqual({ ok: true, repo: 'acme/web' });
  });

  it('falls back to git detection when no flag is given', () => {
    expect(resolveRepo({ detect: () => 'acme/web' }))
      .toEqual({ ok: true, repo: 'acme/web' });
  });

  it('rejects a malformed --repo instead of sending it to the server', () => {
    const result = resolveRepo({ repo: 'not a repo', detect: () => null });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.message).toMatch(/owner\/repo/);
  });

  it('names the fix when detection fails and no flag was given', () => {
    const result = resolveRepo({ detect: () => null });
    expect(result.ok === false && result.message).toMatch(/--repo <owner\/repo>/);
  });
});
