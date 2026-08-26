import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getMe: vi.fn(),
  listProjects: vi.fn(),
  markAuthed: vi.fn(),
}));

vi.mock('./api', () => api);

import { completePostAuth } from './post-auth';

function storageStub(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
	api.getMe.mockResolvedValue({ onboarding_complete: false });
  api.listProjects.mockResolvedValue([]);
  vi.stubGlobal('localStorage', storageStub());
  vi.stubGlobal('sessionStorage', storageStub());
});

describe('completePostAuth', () => {
  it('honors and consumes the stored return path', async () => {
    vi.stubGlobal('sessionStorage', storageStub({ opslane_post_auth_path: '/invite/accept?token=1' }));
    const push = vi.fn().mockResolvedValue(undefined);

    await completePostAuth({ push });

    expect(api.listProjects).not.toHaveBeenCalled();
    expect(api.markAuthed).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem('opslane_post_auth_path')).toBeNull();
    expect(push).toHaveBeenCalledWith('/invite/accept?token=1');
  });

  it('stores the first project before navigating home', async () => {
	api.getMe.mockResolvedValue({ onboarding_complete: true });
    api.listProjects.mockResolvedValue([{ id: 'project_1', name: 'Production' }]);
    const push = vi.fn().mockResolvedValue(undefined);

    await completePostAuth({ push });

    expect(localStorage.getItem('opslane_project_id')).toBe('project_1');
	expect(localStorage.getItem('opslane_project_name')).toBe('Production');
	expect(localStorage.getItem('opslane_onboarding_complete')).toBe('1');
    expect(api.markAuthed).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledWith('/');
  });

	it('routes an incomplete org with an existing project to setup', async () => {
		api.listProjects.mockResolvedValue([{ id: 'project_1', name: 'Production' }]);
		vi.stubGlobal('localStorage', storageStub({ opslane_onboarding_complete: '1' }));
		const push = vi.fn().mockResolvedValue(undefined);

		await completePostAuth({ push });

		expect(localStorage.getItem('opslane_project_id')).toBe('project_1');
		expect(localStorage.getItem('opslane_onboarding_complete')).toBeNull();
		expect(push).toHaveBeenCalledWith('/setup');
	});

  it('navigates users without projects to setup', async () => {
    const push = vi.fn().mockResolvedValue(undefined);

    await completePostAuth({ push });

    expect(api.markAuthed).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledWith('/setup');
  });

  it('does not set the auth marker when bootstrap fails', async () => {
    api.listProjects.mockRejectedValue(new Error('offline'));

    await expect(completePostAuth({ push: vi.fn() })).rejects.toThrow('offline');

    expect(api.markAuthed).not.toHaveBeenCalled();
  });
});
