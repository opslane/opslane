// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import Settings from './Settings.vue';
import { getMe, listEnvironments, listProjects, updateProject } from '../api';

vi.mock('../api', () => ({
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
  default_environment_id: 'env-production',
  created_at: '2026-07-19T00:00:00Z',
};

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
  vi.mocked(listEnvironments).mockResolvedValue({
    environments: [
      { id: 'env-production', project_id: project.id, name: 'production', created_at: project.created_at },
      { id: 'env-staging', project_id: project.id, name: 'staging', created_at: project.created_at },
    ],
    rollup_ready: true,
  });
  vi.mocked(updateProject).mockResolvedValue({ ...project, default_environment_id: 'env-staging' });

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

describe('project default environment setting', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('opslane_project_id', project.id);
    localStorage.setItem('opslane_project_name', project.name);
  });

  afterEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('lets an organization admin change the default without create controls', async () => {
    const wrapper = await mountSettings('admin');
    await wrapper.get('#settings-environments-tab').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Default');
    expect(wrapper.text()).not.toContain('Create environment');
    const makeDefault = wrapper.findAll('button').find((button) => button.text() === 'Make default');
    expect(makeDefault).toBeDefined();
    await makeDefault!.trigger('click');
    await flushPromises();
    expect(updateProject).toHaveBeenCalledWith(project.id, {
      default_environment_id: 'env-staging',
    });
    wrapper.unmount();
  });

  it('shows the default without an action to organization members', async () => {
    const wrapper = await mountSettings('member');
    await wrapper.get('#settings-environments-tab').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Default');
    expect(wrapper.text()).not.toContain('Make default');
    expect(updateProject).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
