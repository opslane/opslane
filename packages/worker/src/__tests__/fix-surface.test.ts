import { describe, expect, it } from 'vitest';
import { isInsideFixSurface, parseCauseLocation } from '../fix-surface.js';

describe('parseCauseLocation', () => {
  it('reads a path with a line number', () => {
    expect(parseCauseLocation('client/asset-panel/src/App.tsx:5')).toEqual({
      kind: 'repo_path', path: 'client/asset-panel/src/App.tsx', line: 5,
    });
  });

  it('reads a path with no line number', () => {
    expect(parseCauseLocation('server/app/routes/api/resources/asset.py')).toEqual({
      kind: 'repo_path', path: 'server/app/routes/api/resources/asset.py',
    });
  });

  it('reads a repository-root file', () => {
    expect(parseCauseLocation('package.json:12')).toEqual({ kind: 'repo_path', path: 'package.json', line: 12 });
  });

  it('strips a leading ./', () => {
    expect(parseCauseLocation('./src/App.tsx:3')).toEqual({ kind: 'repo_path', path: 'src/App.tsx', line: 3 });
  });

  it('strips wrapping backticks', () => {
    expect(parseCauseLocation('`src/App.tsx:3`')).toEqual({ kind: 'repo_path', path: 'src/App.tsx', line: 3 });
  });

  it('recognises an HTTP method and path as an external system', () => {
    expect(parseCauseLocation('GET /issue-context/api/assets/search (remote service)')).toEqual({ kind: 'external_system' });
  });

  it('recognises a URL as an external system', () => {
    expect(parseCauseLocation('https://cdn.example.com/app.js')).toEqual({ kind: 'external_system' });
  });

  it('recognises a hostname as an external system', () => {
    expect(parseCauseLocation('api.assetmanagementforjira.com is not responding')).toEqual({ kind: 'external_system' });
  });

  it('does not mistake a repo path containing a domain-like segment for a host', () => {
    expect(parseCauseLocation('src/example.com/config.ts:4')).toEqual({
      kind: 'repo_path', path: 'src/example.com/config.ts', line: 4,
    });
    expect(parseCauseLocation('config/service.dev.ts')).toEqual({ kind: 'repo_path', path: 'config/service.dev.ts' });
  });

  it('calls bare prose vague, not external', () => {
    expect(parseCauseLocation('the cause could not be determined')).toEqual({ kind: 'vague' });
  });

  it('calls a directory-shaped reference vague', () => {
    expect(parseCauseLocation('src/api')).toEqual({ kind: 'vague' });
  });

  it('calls a path escaping the repo root vague', () => {
    expect(parseCauseLocation('../../../etc/passwd:1')).toEqual({ kind: 'vague' });
  });
});

describe('isInsideFixSurface', () => {
  const frontendOnly = { globs: ['client/**'] };

  it('accepts a path under a configured glob', () => {
    expect(isInsideFixSurface('client/asset-panel/src/App.tsx', frontendOnly)).toBe(true);
  });

  it('rejects a path outside every configured glob', () => {
    expect(isInsideFixSurface('server/app/routes/api/resources/asset.py', frontendOnly)).toBe(false);
  });

  it('accepts everything when no surface is configured', () => {
    expect(isInsideFixSurface('server/app/routes/api/resources/asset.py', { globs: null })).toBe(true);
  });

  it('rejects everything when the surface is configured empty', () => {
    expect(isInsideFixSurface('client/asset-panel/src/App.tsx', { globs: [] })).toBe(false);
  });

  it('matches a single-segment wildcard without crossing directories', () => {
    expect(isInsideFixSurface('client/App.tsx', { globs: ['client/*'] })).toBe(true);
    expect(isInsideFixSurface('client/deep/App.tsx', { globs: ['client/*'] })).toBe(false);
  });

  it('does not let ** swallow a path separator', () => {
    const surface = { globs: ['client/**/App.tsx'] };
    expect(isInsideFixSurface('client/App.tsx', surface)).toBe(true);
    expect(isInsideFixSurface('client/deep/nested/App.tsx', surface)).toBe(true);
    expect(isInsideFixSurface('client/EvilApp.tsx', surface)).toBe(false);
  });
});
