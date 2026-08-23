// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import Settings from './Settings.vue';
import {
  createAPIKey,
  getMe,
  listAPIKeys,
  listEnvironments,
  listProjects,
  revokeAPIKey,
  updateProject,
  type Project,
} from '../api';

vi.mock('../api', () => ({
  createInvitation: vi.fn(),
  createAPIKey: vi.fn(),
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
  listAPIKeys: vi.fn().mockResolvedValue([]),
  listProjects: vi.fn(),
  revokeInvitation: vi.fn(),
  revokeAPIKey: vi.fn(),
  setGitHubConfig: vi.fn(),
  updateProject: vi.fn(),
}));

const project: Project = {
  id: 'project-1',
  name: 'Checkout',
  github_repo: null,
  friction_autonomy: 'ask_first' as const,
  pr_posture: 'verified_only' as const,
  default_environment_id: 'env-production',
  action_scope_enabled: false,
  action_environment_ids: [],
  digest_timezone: 'UTC',
  created_at: '2026-07-19T00:00:00Z',
};

async function mountSettings(
  role?: 'owner' | 'admin' | 'member',
  selectedProject = project,
) {
  vi.mocked(getMe).mockResolvedValue({
    id: 'user-1',
    org_id: 'org-1',
    email: 'person@example.test',
    name: 'Person',
    is_admin: role === 'owner' || role === 'admin',
    active_role: role,
  });
  vi.mocked(listProjects).mockResolvedValue([selectedProject]);
  vi.mocked(listEnvironments).mockResolvedValue({
    environments: [
      { id: 'env-production', project_id: selectedProject.id, name: 'production', created_at: selectedProject.created_at },
      { id: 'env-staging', project_id: selectedProject.id, name: 'staging', created_at: selectedProject.created_at },
    ],
    rollup_ready: true,
  });
  vi.mocked(updateProject).mockResolvedValue({ ...selectedProject, default_environment_id: 'env-staging' });

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

describe('MCP API key management', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('opslane_project_id', project.id);
    localStorage.setItem('opslane_project_name', project.name);
    vi.mocked(listAPIKeys).mockResolvedValue([{
      key_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaa',
      scope: 'api',
      label: 'Claude Code',
      status: 'active',
      redacted: 'opslane_ak_aaaaaaaaaaaaaaaaaaaaaaaaaa_…',
      created_by: 'user-1',
      created_at: '2026-08-22T00:00:00Z',
      last_used_at: null,
      expires_at: '2026-09-22T00:00:00Z',
      revoked_at: null,
    }]);
  });

  afterEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('loads redacted keys for admins when the tab opens', async () => {
    const wrapper = await mountSettings('admin');
    await wrapper.get('#settings-api-keys-tab').trigger('click');
    await flushPromises();

    expect(listAPIKeys).toHaveBeenCalledWith(project.id);
    expect(wrapper.text()).toContain('Claude Code');
    expect(wrapper.text()).toContain('opslane_ak_aaaaaaaaaaaaaaaaaaaaaaaaaa_…');
    expect(wrapper.text()).toContain('Sep');
    wrapper.unmount();
  });

  it('shows a created token once and requires acknowledgement', async () => {
    vi.mocked(createAPIKey).mockResolvedValue({
      key_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbb',
      token: 'opslane_ak_bbbbbbbbbbbbbbbbbbbbbbbbbb_SECRET',
      label: 'Codex',
      scope: 'api',
      expires_at: null,
    });
    const wrapper = await mountSettings('admin');
    await wrapper.get('#settings-api-keys-tab').trigger('click');
    await flushPromises();
    await wrapper.get('#api-key-label').setValue('Codex');
    await wrapper.get('#api-key-create-form').trigger('submit');
    await flushPromises();

    expect(createAPIKey).toHaveBeenCalledWith(project.id, { label: 'Codex', expires_at: null });
    expect(wrapper.text()).toContain('opslane_ak_bbbbbbbbbbbbbbbbbbbbbbbbbb_SECRET');
    const done = wrapper.findAll('button').find((button) => button.text() === 'Done');
    expect(done?.attributes('disabled')).toBeDefined();
    await wrapper.get('#api-key-acknowledged').setValue(true);
    await done!.trigger('click');
    expect(wrapper.text()).not.toContain('opslane_ak_bbbbbbbbbbbbbbbbbbbbbbbbbb_SECRET');
    wrapper.unmount();
  });

  it('confirms revocation and hides key management from members', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(revokeAPIKey).mockResolvedValue(undefined);
    const wrapper = await mountSettings('admin');
    await wrapper.get('#settings-api-keys-tab').trigger('click');
    await flushPromises();
    await wrapper.get('[data-revoke-api-key="aaaaaaaaaaaaaaaaaaaaaaaaaa"]').trigger('click');
    await flushPromises();
    expect(revokeAPIKey).toHaveBeenCalledWith(project.id, 'aaaaaaaaaaaaaaaaaaaaaaaaaa');
    wrapper.unmount();

    const member = await mountSettings('member');
    expect(member.find('#settings-api-keys-tab').exists()).toBe(false);
    member.unmount();
  });
});

describe('daily digest timezone setting', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('opslane_project_id', project.id);
    localStorage.setItem('opslane_project_name', project.name);
  });

  afterEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('shows the project timezone and saves a changed IANA zone', async () => {
    const wrapper = await mountSettings('admin');
    vi.mocked(updateProject).mockResolvedValue({
      ...project,
      digest_timezone: 'America/New_York',
    });

    const timezone = wrapper.get('#digest-timezone');
    expect((timezone.element as HTMLInputElement).value).toBe('UTC');
    expect(timezone.attributes('list')).toBe('digest-timezone-options');
    expect(wrapper.get('#digest-timezone-options').findAll('option').length).toBeGreaterThan(1);

    await timezone.setValue('America/New_York');
    await flushPromises();

    expect(updateProject).toHaveBeenCalledWith(project.id, {
      digest_timezone: 'America/New_York',
    });
    wrapper.unmount();
  });
});

describe('environment action scope setting', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('opslane_project_id', project.id);
    localStorage.setItem('opslane_project_name', project.name);
  });

  afterEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('renders server state and saves selected environments', async () => {
    const scopedProject = {
      ...project,
      action_scope_enabled: true,
      action_environment_ids: ['env-production'],
    };
    const wrapper = await mountSettings('admin', scopedProject);
    await wrapper.get('#settings-environments-tab').trigger('click');
    await flushPromises();

    expect((wrapper.get('#action-scope-enabled').element as HTMLInputElement).checked).toBe(true);
    expect((wrapper.get('[data-action-environment-id="env-production"]').element as HTMLInputElement).checked).toBe(true);
    expect((wrapper.get('[data-action-environment-id="env-staging"]').element as HTMLInputElement).checked).toBe(false);

    await wrapper.get('[data-action-environment-id="env-staging"]').setValue(true);
    vi.mocked(updateProject).mockResolvedValue({
      ...scopedProject,
      action_environment_ids: ['env-production', 'env-staging'],
    });
    const save = wrapper.findAll('button').find((button) => button.text() === 'Save automation scope');
    await save!.trigger('click');
    await flushPromises();

    expect(updateProject).toHaveBeenCalledWith(project.id, {
      action_environment_ids: ['env-production', 'env-staging'],
    });
    wrapper.unmount();
  });

  it('saves null when disabled and [] with fails-closed copy when enabled empty', async () => {
    const wrapper = await mountSettings('admin');
    await wrapper.get('#settings-environments-tab').trigger('click');
    await flushPromises();

    await wrapper.get('#action-scope-enabled').setValue(true);
    expect(wrapper.text()).toContain('No environments selected — automatic investigation is off for this project.');
    let save = wrapper.findAll('button').find((button) => button.text() === 'Save automation scope');
    await save!.trigger('click');
    await flushPromises();
    expect(updateProject).toHaveBeenLastCalledWith(project.id, { action_environment_ids: [] });

    vi.mocked(updateProject).mockResolvedValue(project);
    await wrapper.get('#action-scope-enabled').setValue(false);
    save = wrapper.findAll('button').find((button) => button.text() === 'Save automation scope');
    await save!.trigger('click');
    await flushPromises();
    expect(updateProject).toHaveBeenLastCalledWith(project.id, { action_environment_ids: null });
    wrapper.unmount();
  });

  it('restores last-known server state when saving fails', async () => {
    const scopedProject = {
      ...project,
      action_scope_enabled: true,
      action_environment_ids: ['env-production'],
    };
    const wrapper = await mountSettings('admin', scopedProject);
    await wrapper.get('#settings-environments-tab').trigger('click');
    await flushPromises();

    await wrapper.get('[data-action-environment-id="env-staging"]').setValue(true);
    vi.mocked(updateProject).mockRejectedValue(new Error('invalid environment'));
    const save = wrapper.findAll('button').find((button) => button.text() === 'Save automation scope');
    await save!.trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('invalid environment');
    expect((wrapper.get('[data-action-environment-id="env-production"]').element as HTMLInputElement).checked).toBe(true);
    expect((wrapper.get('[data-action-environment-id="env-staging"]').element as HTMLInputElement).checked).toBe(false);
    wrapper.unmount();
  });
});
