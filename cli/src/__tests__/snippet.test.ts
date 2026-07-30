import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getSnippet } from '../snippet.js';
import { saveAgentCredentials } from '../agent-credentials.js';
import { TEST_PUBLIC_KEY } from './fixtures.js';

vi.spyOn(console, 'log').mockImplementation(() => {});

describe('getSnippet', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'opslane-snippet-'));
    await mkdir(join(tmpDir, 'src'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('detects react-vite framework from package.json', async () => {
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        dependencies: { react: '^18.0.0' },
        devDependencies: { vite: '^5.0.0' },
      }),
    );
    await writeFile(join(tmpDir, 'src', 'main.tsx'), 'import React from "react";');

    const result = await getSnippet({ cwd: tmpDir, apiKey: TEST_PUBLIC_KEY });
    expect(result.framework).toBe('react-vite');
    expect(result.install).toContain('@opslane/sdk');
    expect(result.env).toEqual({
      var: 'VITE_OPSLANE_API_KEY', value: TEST_PUBLIC_KEY, file: '.env.local', gitignore: true,
    });
  });

  it('returns unknown framework when no package.json', async () => {
    const result = await getSnippet({ cwd: tmpDir, apiKey: TEST_PUBLIC_KEY });
    expect(result.framework).toBe('unknown');
  });

  it('uses --framework flag when provided', async () => {
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: {} }),
    );

    const result = await getSnippet({
      cwd: tmpDir,
      framework: 'vue-vite',
      apiKey: TEST_PUBLIC_KEY,
    });
    expect(result.framework).toBe('vue-vite');
  });

  it('detects the package manager and emits a self-hosted endpoint', async () => {
    await writeFile(join(tmpDir, 'package.json'), JSON.stringify({ dependencies: { react: '^18' }, devDependencies: { vite: '^5' } }));
    await writeFile(join(tmpDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
    await writeFile(join(tmpDir, 'src', 'main.tsx'), "import React from 'react';\n");
    const credentialsPath = join(tmpDir, 'agent-credentials.json');
    await saveAgentCredentials({
      org_id: 'org', project_id: 'project', api_key: 'self-key', repo: 'acme/app', api_url: 'http://localhost:8082',
    }, credentialsPath);

    const result = await getSnippet({
      cwd: tmpDir, repo: 'acme/app', apiUrl: 'http://localhost:8082', credentialsPath,
    });
    expect(result.install).toBe('pnpm add @opslane/sdk');
    expect(result.endpoint).toBe('http://localhost:8082');
    expect(JSON.stringify(result.patches)).toContain("endpoint: 'http://localhost:8082'");
    expect(result.env.value).toBe('self-key');
  });
});
