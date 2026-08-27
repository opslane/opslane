// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getMe: vi.fn(),
  getOnboardingState: vi.fn(),
  onboardingSetup: vi.fn(),
  getEventStatus: vi.fn(),
  getGitHubAppStatus: vi.fn(),
  listGitHubRepos: vi.fn(),
  setGitHubConfig: vi.fn(),
  createAPIKey: vi.fn(),
  createNotificationDestination: vi.fn(),
  testNotificationDestination: vi.fn(),
  updateNotificationDestination: vi.fn(),
  updateProject: vi.fn(),
  completeOnboarding: vi.fn(),
  listProjects: vi.fn(),
}));
const routerPush = vi.hoisted(() => vi.fn());

vi.mock('../../api', () => api);
vi.mock('vue-router', () => ({ useRouter: () => ({ push: routerPush }) }));

import SetupWizard from '../SetupWizard.vue';

const baseState = {
  onboarding_complete: false,
  next_step: 'create_project',
  project_id: null,
  has_events: false,
  github_connected: false,
  github_mode: 'app',
  slack_connected: false,
};

describe('SetupWizard', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    localStorage.clear();
    api.getMe.mockResolvedValue({ active_role: 'admin' });
    api.getOnboardingState.mockResolvedValue({ ...baseState });
    api.listProjects.mockResolvedValue([{ id: 'p1', name: 'web' }]);
    api.getGitHubAppStatus.mockResolvedValue({
      installed: false,
      installation_id: null,
      install_url: 'https://github.com/apps/x/installations/new',
    });
    api.listGitHubRepos.mockResolvedValue([]);
    api.updateProject.mockResolvedValue({ id: 'p1' });
  });

  it('resumes at the server-derived step, restores localStorage, and mints a key', async () => {
    api.getOnboardingState.mockResolvedValue({ ...baseState, next_step: 'install_sdk', project_id: 'p1' });
    api.createAPIKey.mockResolvedValue({
      key_id: 'k1', token: 'opslane_pk_resume', label: 'onboarding', scope: 'ingest', expires_at: null,
    });
    api.getEventStatus.mockResolvedValue({ has_events: false, latest_error_group_id: null });
    const wrapper = mount(SetupWizard);
    await flushPromises();
    expect(wrapper.text()).toContain('Install the SDK');
    expect(api.createAPIKey).toHaveBeenCalledWith('p1', {
      label: 'onboarding', expires_at: null, scope: 'ingest',
    });
    expect(wrapper.text()).toContain('opslane_pk_resume');
    // The snippet always carries an explicit endpoint (the SDK default is not trusted).
    expect(wrapper.text()).toContain(`endpoint: '${window.location.origin}'`);
    expect(localStorage.getItem('opslane_project_id')).toBe('p1');
    expect(api.onboardingSetup).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('shows event success with the group link before Continue advances', async () => {
    api.getOnboardingState.mockResolvedValue({ ...baseState, next_step: 'install_sdk', project_id: 'p1' });
    api.createAPIKey.mockResolvedValue({
      key_id: 'k1', token: 'opslane_pk_x', label: 'onboarding', scope: 'ingest', expires_at: null,
    });
    api.getEventStatus.mockResolvedValueOnce({ has_events: false, latest_error_group_id: null });
    api.getEventStatus.mockResolvedValue({ has_events: true, latest_error_group_id: 'g1' });
    const wrapper = mount(SetupWizard);
    await flushPromises();
    expect(wrapper.find('[data-testid="sdk-continue"]').exists()).toBe(false);
    await vi.advanceTimersByTimeAsync(6001);
    await flushPromises();
    expect(wrapper.get('[data-testid="latest-group-link"]').attributes('href')).toContain('g1');
    await wrapper.get('[data-testid="sdk-continue"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Connect GitHub');
    wrapper.unmount();
  });

  it('enables Slack only after ok:true and completes onboarding', async () => {
    api.getOnboardingState.mockResolvedValue({
      ...baseState, next_step: 'connect_slack', project_id: 'p1', has_events: true, github_connected: true,
    });
    api.createNotificationDestination.mockResolvedValue({ id: 'd1', enabled: false });
    api.testNotificationDestination.mockResolvedValue({ ok: true, classification: 'delivered', status_code: 200 });
    api.updateNotificationDestination.mockResolvedValue({ id: 'd1', enabled: true });
    api.completeOnboarding.mockResolvedValue({ onboarding_complete: true });
    const wrapper = mount(SetupWizard);
    await flushPromises();
    await wrapper.get('#slack-webhook-url').setValue('https://hooks.slack.com/services/T0/B0/x');
    await wrapper.get('[data-testid="slack-connect"]').trigger('submit');
    await flushPromises();
    expect(api.createNotificationDestination).toHaveBeenCalledWith('p1', expect.objectContaining({
      enabled: false, delivery_policy: 'post_triage',
    }));
    expect(api.updateNotificationDestination).toHaveBeenCalledWith('p1', 'd1', { enabled: true });
    expect(api.completeOnboarding).toHaveBeenCalled();
    expect(wrapper.text()).toContain('You are set up');
    wrapper.unmount();
  });

  it('never enables Slack when its test returns ok:false', async () => {
    api.getOnboardingState.mockResolvedValue({
      ...baseState, next_step: 'connect_slack', project_id: 'p1', has_events: true, github_connected: true,
    });
    api.createNotificationDestination.mockResolvedValue({ id: 'd1', enabled: false });
    api.testNotificationDestination.mockResolvedValue({ ok: false, classification: 'http_404', status_code: 404 });
    const wrapper = mount(SetupWizard);
    await flushPromises();
    await wrapper.get('#slack-webhook-url').setValue('https://hooks.slack.com/services/T0/B0/x');
    await wrapper.get('[data-testid="slack-connect"]').trigger('submit');
    await flushPromises();
    expect(api.updateNotificationDestination).not.toHaveBeenCalledWith('p1', 'd1', { enabled: true });
    expect(wrapper.text()).toContain("couldn't reach that webhook");
    wrapper.unmount();
  });

  it('shows completion failure instead of the done screen', async () => {
    api.getOnboardingState.mockResolvedValue({
      ...baseState, next_step: 'connect_github', project_id: 'p1', has_events: true,
    });
    api.completeOnboarding.mockRejectedValue(new Error('server exploded'));
    const wrapper = mount(SetupWizard);
    await flushPromises();
    await wrapper.get('[data-testid="defer-github"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="defer-slack"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).not.toContain('You are set up');
    expect(wrapper.text()).toContain('server exploded');
    wrapper.unmount();
  });

  it('routes an already-complete org straight to the dashboard', async () => {
    api.getOnboardingState.mockResolvedValue({
      ...baseState, onboarding_complete: true, next_step: 'done', project_id: 'p1',
    });
    const wrapper = mount(SetupWizard);
    await flushPromises();
    expect(localStorage.getItem('opslane_project_id')).toBe('p1');
    expect(routerPush).toHaveBeenCalledWith('/');
    wrapper.unmount();
  });

  it('completes facts-complete state instead of forcing a step backward', async () => {
    api.getOnboardingState.mockResolvedValue({
      ...baseState, next_step: 'done', project_id: 'p1', has_events: true,
      github_connected: true, slack_connected: true,
    });
    api.completeOnboarding.mockResolvedValue({ onboarding_complete: true });
    const wrapper = mount(SetupWizard);
    await flushPromises();
    expect(api.completeOnboarding).toHaveBeenCalled();
    wrapper.unmount();
  });

  it('stops cloud members before mutation controls', async () => {
    api.getMe.mockResolvedValue({ active_role: 'member' });
    const wrapper = mount(SetupWizard);
    await flushPromises();
    expect(wrapper.text()).toContain('Ask an organization admin');
    expect(api.getOnboardingState).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
