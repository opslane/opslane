// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProject, listEnvironments, listIncidents, listSessions, updateProject } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('project settings API', () => {
  it('sends the draft posture as a partial project PATCH', async () => {
    const project = {
      id: 'project-1',
      name: 'Example',
      github_repo: 'acme/example',
      friction_autonomy: 'ask_first' as const,
      pr_posture: 'draft_when_unverified' as const,
      default_environment_id: 'env-production',
      created_at: '2026-07-17T00:00:00Z',
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => project,
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(updateProject('project-1', {
      pr_posture: 'draft_when_unverified',
    })).resolves.toEqual(project);

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/projects/project-1', expect.objectContaining({
      method: 'PATCH',
      credentials: 'include',
      body: JSON.stringify({ pr_posture: 'draft_when_unverified' }),
    }));
  });

  it('sends the project default as a partial project PATCH', async () => {
    const project = {
      id: 'project-1',
      name: 'Example',
      github_repo: 'acme/example',
      friction_autonomy: 'ask_first' as const,
      pr_posture: 'verified_only' as const,
      default_environment_id: 'env-staging',
      created_at: '2026-07-17T00:00:00Z',
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => project,
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(updateProject('project-1', {
      default_environment_id: 'env-staging',
    })).resolves.toEqual(project);

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/projects/project-1', expect.objectContaining({
      method: 'PATCH',
      credentials: 'include',
      body: JSON.stringify({ default_environment_id: 'env-staging' }),
    }));
  });

  it('sends the project provisioning idempotency token and returns the composite bundle', async () => {
    const bundle = {
      project: {
        id: 'project-2',
        name: 'Checkout',
        github_repo: null,
        friction_autonomy: 'ask_first' as const,
        pr_posture: 'verified_only' as const,
        default_environment_id: 'env-2',
        created_at: '2026-07-19T00:00:00Z',
      },
      environment: {
        id: 'env-2',
        project_id: 'project-2',
        name: 'production',
        created_at: '2026-07-19T00:00:00Z',
      },
      api_key: {
        id: 'key-2',
        raw_key: 'opslane_pk_mzxw6ytboi3damrrgi3tknzxgq_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      },
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => bundle,
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(createProject('Checkout', '', 'attempt-2')).resolves.toEqual(bundle);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/projects', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        name: 'Checkout',
        github_repo: undefined,
        idempotency_token: 'attempt-2',
      }),
    }));
  });
});

describe('environment-filtered API reads', () => {
  it('threads supported filters through incident and session list queries only when set', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [],
    });
    vi.stubGlobal('fetch', fetchMock);

    await listIncidents('project-1', { environment_id: 'env-production' });
    await listIncidents('project-1', {});
    await listSessions('project-1', {
      environment_id: 'env-staging',
      search: 'jane@acme.com',
      has_signals: true,
    });
    await listSessions('project-1', {});

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/projects/project-1/incidents?environment_id=env-production',
      '/api/v1/projects/project-1/incidents',
      '/api/v1/projects/project-1/sessions?search=jane%40acme.com&has_signals=true&environment_id=env-staging',
      '/api/v1/projects/project-1/sessions',
    ]);
  });

  it('returns the environment list together with rollup readiness', async () => {
    const response = {
      environments: [{
        id: 'env-production',
        project_id: 'project-1',
        name: 'production',
        created_at: '2026-07-19T00:00:00Z',
      }],
      rollup_ready: true,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => response,
    }));

    await expect(listEnvironments('project-1')).resolves.toEqual(response);
    await expect(listEnvironments('project-1', 'incidents')).resolves.toEqual(response);
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/projects/project-1/environments',
      '/api/v1/projects/project-1/environments?used_by=incidents',
    ]);
  });
});
