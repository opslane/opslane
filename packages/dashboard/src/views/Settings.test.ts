// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import Settings from './Settings.vue';
import {
  createBillingCheckout,
  createAPIKey,
  fetchAuthConfig,
  getBillingSummary,
  getMe,
  listAPIKeys,
  listEnvironments,
  listProjects,
  openBillingPortal,
  revokeAPIKey,
  updateProject,
  type Project,
} from '../api';

vi.mock('../api', () => ({
  createBillingCheckout: vi.fn(),
  createInvitation: vi.fn(),
  createAPIKey: vi.fn(),
  createProject: vi.fn(),
  deleteGitHubConfig: vi.fn(),
  fetchAuthConfig: vi.fn(),
  getBillingSummary: vi.fn(),
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
  openBillingPortal: vi.fn(),
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
  options: {
    billingEnabled?: boolean;
    query?: Record<string, string>;
    navigate?: (target: string) => void;
  } = {},
) {
  vi.mocked(getMe).mockResolvedValue({
    id: 'user-1',
    org_id: 'org-1',
    email: 'person@example.test',
    name: 'Person',
    is_admin: role === 'owner' || role === 'admin',
    active_role: role,
  });
  vi.mocked(fetchAuthConfig).mockResolvedValue({
    provider: 'embedded',
    supports_password: false,
    supports_signup: false,
    supports_reset: false,
    social_providers: [],
    billing_enabled: options.billingEnabled ?? false,
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
  await router.push({ path: '/settings', query: options.query });
  await router.isReady();
  const wrapper = mount(Settings, {
    props: { navigate: options.navigate },
    global: { plugins: [router] },
  });
  await flushPromises();
  return wrapper;
}

describe('billing settings', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('opslane_project_id', project.id);
    localStorage.setItem('opslane_project_name', project.name);
    vi.mocked(getBillingSummary).mockResolvedValue({ plan_id: 'free', is_pro: false, features: [] });
  });

  afterEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('shows billing only when enabled and the user can administer the organization', async () => {
    const disabled = await mountSettings('owner');
    expect(disabled.find('#settings-billing-tab').exists()).toBe(false);
    disabled.unmount();

    const member = await mountSettings('member', project, { billingEnabled: true });
    expect(member.find('#settings-billing-tab').exists()).toBe(false);
    member.unmount();

    for (const role of ['admin', 'owner', undefined] as const) {
      const wrapper = await mountSettings(role, project, { billingEnabled: true });
      expect(wrapper.find('#settings-billing-tab').exists()).toBe(true);
      wrapper.unmount();
    }
  });

  it('opens an authorized billing deep link after auth finishes loading', async () => {
    const wrapper = await mountSettings('admin', project, {
      billingEnabled: true,
      query: { tab: 'billing' },
    });

    expect(wrapper.get('#settings-billing-tab').attributes('aria-selected')).toBe('true');
    expect(wrapper.find('#settings-project-panel').exists()).toBe(false);
    wrapper.unmount();
  });

  it('renders the plan and merged fix PR usage from the billing summary', async () => {
    vi.mocked(getBillingSummary).mockResolvedValue({
      plan_id: 'free',
      is_pro: false,
      features: [
        { feature_id: 'merged_prs', allowed: true, granted: 2, usage: 1, remaining: 1 },
        { feature_id: 'investigations', allowed: true, unlimited: true },
      ],
    });
    const wrapper = await mountSettings('admin', project, { billingEnabled: true });

    await wrapper.get('#settings-billing-tab').trigger('click');
    await flushPromises();

    expect(getBillingSummary).toHaveBeenCalledOnce();
    expect(wrapper.get('#settings-billing-panel').text()).toContain('Free');
    expect(wrapper.text()).toContain('Merged fix PRs');
    expect(wrapper.text()).toContain('1 of 2 used');
    expect(wrapper.get('[data-billing-usage="merged_prs"]').attributes('style')).toContain('width: 50%');
    expect(wrapper.text()).toContain('Investigations (fair use)');
    expect(wrapper.text()).toContain('Unlimited');
    wrapper.unmount();
  });

  it('shows an inline unavailable state when the provider summary fails', async () => {
    vi.mocked(getBillingSummary).mockRejectedValue(new Error('API 502'));
    const wrapper = await mountSettings('owner', project, { billingEnabled: true });

    await wrapper.get('#settings-billing-tab').trigger('click');
    await flushPromises();

    expect(wrapper.get('#settings-billing-panel').text()).toContain('Billing is temporarily unavailable');
    wrapper.unmount();
  });

  it('starts an upgrade checkout and navigates to its URL', async () => {
    vi.mocked(createBillingCheckout).mockResolvedValue({ url: 'https://pay.example.test/checkout' });
    const assign = vi.fn();
    const wrapper = await mountSettings('admin', project, {
      billingEnabled: true,
      navigate: assign,
    });

    await wrapper.get('#settings-billing-tab').trigger('click');
    await flushPromises();
    await wrapper.get('[data-billing-upgrade]').trigger('click');
    await flushPromises();

    expect(createBillingCheckout).toHaveBeenCalledOnce();
    expect(assign).toHaveBeenCalledWith('https://pay.example.test/checkout');
    wrapper.unmount();
  });

  it('hides upgrade on Pro and opens the customer billing portal', async () => {
    vi.mocked(getBillingSummary).mockResolvedValue({ plan_id: 'pro', is_pro: true, features: [] });
    vi.mocked(openBillingPortal).mockResolvedValue({ url: 'https://portal.example.test/customer' });
    const navigate = vi.fn();
    const wrapper = await mountSettings('owner', project, {
      billingEnabled: true,
      navigate,
    });

    await wrapper.get('#settings-billing-tab').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-billing-upgrade]').exists()).toBe(false);
    await wrapper.get('[data-billing-portal]').trigger('click');
    await flushPromises();

    expect(openBillingPortal).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith('https://portal.example.test/customer');
    wrapper.unmount();
  });
});

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
