import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getStatus } from '../status.js';
import { saveAgentCredentials } from '../agent-credentials.js';
import { TEST_PUBLIC_KEY } from './fixtures.js';

vi.spyOn(console, 'log').mockImplementation(() => {});

describe('getStatus', () => {
  let tmpDir: string;
  let credFile: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'opslane-status-'));
    credFile = join(tmpDir, 'credentials.json');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns no_credentials when no credentials match', async () => {
    const result = await getStatus({ credentialsPath: join(tmpDir, 'missing.json') });
    expect(result.status).toBe('no_credentials');
  });

  it('returns configured when credentials exist', async () => {
    await saveAgentCredentials({
      org_id: 'org-1',
      project_id: 'proj-1',
      api_key: TEST_PUBLIC_KEY,
      repo: 'acme/app',
      api_url: 'http://localhost:8082',
    }, credFile);

    const result = await getStatus({ credentialsPath: credFile, apiUrl: 'http://localhost:8082', repo: 'acme/app' });
    expect(result.status).toBe('configured');
    expect(result.repo).toBe('acme/app');
  });
});
