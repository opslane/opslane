// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import Settings from './Settings.vue';
import { getMe, listProjects, updateProject } from '../api';

vi.mock('../api', () => ({
  createEnvironment: vi.fn(),
  createInvitation: vi.fn(),
  createProject: vi.fn(),
  deleteGitHubConfig: vi.fn(),
  getFixStats: vi.fn().mockResolvedValue({
    error: {},
    friction: {},
  }),
  getGitHubAppStatus: vi.fn().mockResolvedValue({ installed: false }),
  getGitHubConfig: vi.fn().mockResolvedValue(null),
  getMe: vi.fn(),
  listEnvironments: vi.fn().mockResolvedValue({ environments: [], rollup_ready: true }),
  listInvitations: vi.fn().mockResolvedValue([]),
  listProjects: vi.fn(),
  revokeInvitation: vi.fn(),
  setGitHubConfig: vi.fn(),
  updateProject: vi.fn(),
}));

const project = {
  id: 'project-1',
  name: 'Checkout',
  github_repo: null,
  friction_autonomy: 'ask_first' as const,
  pr_posture: 'verified_only' as const,
  allow_payload_environment: false,
  created_at: '2026-07-19T00:00:00Z',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function mountSettings(role?: 'owner' | 'admin' | 'member') {
  vi.mocked(getMe).mockResolvedValue({
    id: 'user-1',
    org_id: 'org-1',
    email: 'person@example.test',
    name: 'Person',
    is_admin: role === 'owner' || role === 'admin',
    active_role: role,
  });
  vi.mocked(listProjects).mockResolvedValue([project]);
  vi.mocked(updateProject).mockResolvedValue({ ...project, allow_payload_environment: true });

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/settings', component: Settings }],
  });
  await router.push('/settings');
  await router.isReady();
  const wrapper = mount(Settings, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
}

describe('payload environment project setting', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('opslane_project_id', project.id);
    localStorage.setItem('opslane_project_name', project.name);
  });

  afterEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('lets an organization admin opt in after showing the key-boundary warning', async () => {
    const wrapper = await mountSettings('admin');

    expect(wrapper.text()).toContain('Allow SDK environment override');
    expect(wrapper.text()).toContain('environment-bound API key');
    const toggle = wrapper.get<HTMLInputElement>('input[aria-labelledby="payload-environment-heading"]');
    expect(toggle.element.disabled).toBe(false);

    await toggle.setValue(true);
    await flushPromises();

    expect(updateProject).toHaveBeenCalledWith(project.id, {
      allow_payload_environment: true,
    });
    expect(toggle.element.checked).toBe(true);
    wrapper.unmount();
  });

  it('shows the project setting read-only to organization members', async () => {
    const wrapper = await mountSettings('member');

    const toggle = wrapper.get<HTMLInputElement>('input[aria-labelledby="payload-environment-heading"]');
    expect(toggle.element.disabled).toBe(true);
    expect(wrapper.text()).toContain('Only organization admins can change this setting.');

    await toggle.trigger('change');
    expect(updateProject).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('allows the setting in OSS mode where auth/me has no organization role', async () => {
    const wrapper = await mountSettings();

    const toggle = wrapper.get<HTMLInputElement>('input[aria-labelledby="payload-environment-heading"]');
    expect(toggle.element.disabled).toBe(false);
    wrapper.unmount();
  });

  it('keeps the toggle disabled until the cloud role is known', async () => {
    const me = deferred<Awaited<ReturnType<typeof getMe>>>();
    vi.mocked(getMe).mockReturnValue(me.promise);
    vi.mocked(listProjects).mockResolvedValue([project]);

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/settings', component: Settings }],
    });
    await router.push('/settings');
    await router.isReady();
    const wrapper = mount(Settings, { global: { plugins: [router] } });
    await flushPromises();

    const toggle = wrapper.get<HTMLInputElement>('input[aria-labelledby="payload-environment-heading"]');
    expect(toggle.element.disabled).toBe(true);

    me.resolve({
      id: 'user-1',
      org_id: 'org-1',
      email: 'member@example.test',
      name: 'Member',
      is_admin: false,
      active_role: 'member',
    });
    await flushPromises();
    expect(toggle.element.disabled).toBe(true);
    wrapper.unmount();
  });
});
