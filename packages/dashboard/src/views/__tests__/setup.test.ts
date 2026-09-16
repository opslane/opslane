// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getMe: vi.fn(),
  getOnboardingState: vi.fn(),
  completeOnboarding: vi.fn(),
  listProjects: vi.fn(),
}));
const routerPush = vi.hoisted(() => vi.fn());

vi.mock('../../api', () => api);
vi.mock('vue-router', () => ({ useRouter: () => ({ push: routerPush }) }));

import Setup from '../Setup.vue';

const waiting = {
  onboarding_complete: false,
  project_id: null as string | null,
  has_events: false,
  github_connected: false,
  github_mode: 'app' as const,
  slack_connected: false,
};

async function advance(ms = 3000): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await flushPromises();
}

function status(w: ReturnType<typeof mount>): string {
  return w.get('[data-testid="setup-status"]').text();
}

describe('Setup', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    localStorage.clear();
    api.getMe.mockResolvedValue({ active_role: 'admin' });
    api.getOnboardingState.mockResolvedValue({ ...waiting });
    api.completeOnboarding.mockResolvedValue({ onboarding_complete: true });
    api.listProjects.mockResolvedValue([{ id: 'p1', name: 'web' }]);
    routerPush.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows only the agent prompt and the waiting status', async () => {
    const w = mount(Setup);
    await flushPromises();
    expect(w.text()).toContain('Set up Opslane with your coding agent');
    expect(w.get('[data-testid="agent-paste-line"]').text()).toBe('Set up https://docs.opslane.com/INSTALL.md');
    expect(status(w)).toContain('Waiting for your agent. It will give you a link to approve.');
    expect(w.find('input').exists()).toBe(false);
    expect(w.text()).not.toMatch(/Connect GitHub|Connect Slack|Do this later|Create project/);
    w.unmount();
  });

  it('moves through the status lines as server facts change and keeps polling through a failure', async () => {
    api.getOnboardingState
      .mockResolvedValueOnce({ ...waiting })
      .mockResolvedValueOnce({ ...waiting, project_id: 'p1' })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ ...waiting, project_id: 'p1' });
    const w = mount(Setup);
    await flushPromises();
    expect(status(w)).toContain('Waiting for your agent');
    await advance();
    expect(status(w)).toContain('Project ready. Waiting for the first event from your app.');
    await advance();
    expect(status(w)).toContain('Could not check setup status. Retrying.');
    await advance();
    expect(status(w)).toContain('Project ready');
    expect(api.completeOnboarding).not.toHaveBeenCalled();
    expect(routerPush).not.toHaveBeenCalled();
    w.unmount();
  });

  it('never overlaps state requests', async () => {
    let resolveState: (value: typeof waiting) => void = () => undefined;
    api.getOnboardingState.mockImplementationOnce(() => new Promise((resolve) => { resolveState = resolve; }));
    const w = mount(Setup);
    await flushPromises();
    await advance(10_000);
    expect(api.getOnboardingState).toHaveBeenCalledTimes(1);
    resolveState({ ...waiting });
    await flushPromises();
    await advance();
    expect(api.getOnboardingState).toHaveBeenCalledTimes(2);
    w.unmount();
  });

  it('completes onboarding on the first event, selects the project, and opens the dashboard', async () => {
    api.getOnboardingState
      .mockResolvedValueOnce({ ...waiting, project_id: 'p2' })
      .mockResolvedValue({ ...waiting, project_id: 'p2', has_events: true });
    api.listProjects.mockResolvedValue([{ id: 'p1', name: 'old' }, { id: 'p2', name: 'web' }]);
    localStorage.setItem('opslane_environment_id', 'env-stale');
    let finishComplete: () => void = () => undefined;
    api.completeOnboarding.mockImplementationOnce(() => new Promise((resolve) => { finishComplete = () => resolve({ onboarding_complete: true }); }));
    const w = mount(Setup);
    await flushPromises();
    await advance();
    expect(api.completeOnboarding).toHaveBeenCalledTimes(1);
    expect(status(w)).toContain('First event received. Opening your dashboard…');
    expect(routerPush).not.toHaveBeenCalled();
    finishComplete();
    await flushPromises();
    expect(localStorage.getItem('opslane_onboarding_complete')).toBe('1');
    expect(localStorage.getItem('opslane_project_id')).toBe('p2');
    expect(localStorage.getItem('opslane_project_name')).toBe('web');
    expect(localStorage.getItem('opslane_environment_id')).toBeNull();
    expect(routerPush).toHaveBeenCalledWith('/');
    await advance(10_000);
    expect(api.getOnboardingState).toHaveBeenCalledTimes(2);
    w.unmount();
  });

  it('shows Try again when completion fails, stays on setup, and retries', async () => {
    api.getOnboardingState.mockResolvedValue({ ...waiting, project_id: 'p1', has_events: true });
    api.completeOnboarding.mockRejectedValueOnce(new Error('API 500')).mockResolvedValue({ onboarding_complete: true });
    const w = mount(Setup);
    await flushPromises();
    expect(w.text()).toContain('Could not finish setup.');
    expect(w.text()).toContain('API 500');
    expect(routerPush).not.toHaveBeenCalled();
    expect(localStorage.getItem('opslane_onboarding_complete')).toBeNull();
    await advance(10_000);
    expect(api.completeOnboarding).toHaveBeenCalledTimes(1);
    await w.get('[data-testid="setup-retry-complete"]').trigger('click');
    await flushPromises();
    expect(api.completeOnboarding).toHaveBeenCalledTimes(2);
    expect(routerPush).toHaveBeenCalledWith('/');
    w.unmount();
  });

  it('enters an onboarded org that has a project without calling complete', async () => {
    api.getOnboardingState.mockResolvedValue({ ...waiting, onboarding_complete: true, project_id: 'p1', has_events: true });
    const w = mount(Setup);
    await flushPromises();
    expect(api.completeOnboarding).not.toHaveBeenCalled();
    expect(localStorage.getItem('opslane_project_id')).toBe('p1');
    expect(routerPush).toHaveBeenCalledWith('/');
    w.unmount();
  });

  it('selects the first available project when the state project was removed', async () => {
    api.getOnboardingState.mockResolvedValue({ ...waiting, onboarding_complete: true, project_id: 'removed' });
    const w = mount(Setup);
    await flushPromises();
    expect(localStorage.getItem('opslane_project_id')).toBe('p1');
    expect(localStorage.getItem('opslane_project_name')).toBe('web');
    expect(routerPush).toHaveBeenCalledWith('/');
    w.unmount();
  });

  it('keeps an onboarded org with no project on the prompt, then enters once a project exists', async () => {
    api.getOnboardingState
      .mockResolvedValueOnce({ ...waiting, onboarding_complete: true })
      .mockResolvedValue({ ...waiting, onboarding_complete: true, project_id: 'p1' });
    const w = mount(Setup);
    await flushPromises();
    expect(routerPush).not.toHaveBeenCalled();
    expect(w.find('[data-testid="agent-paste-line"]').exists()).toBe(true);
    await advance();
    expect(api.completeOnboarding).not.toHaveBeenCalled();
    expect(routerPush).toHaveBeenCalledWith('/');
    w.unmount();
  });

  // 'viewer' stands in for any role added later: the server fails closed on
  // roles it does not know, so the page must not try to complete for them.
  it.each(['member', 'viewer'])('shows %s the ask-an-admin screen, never completes, and enters once the org is ready', async (role) => {
    api.getMe.mockResolvedValue({ active_role: role });
    api.getOnboardingState
      .mockResolvedValueOnce({ ...waiting, project_id: 'p1', has_events: true })
      .mockResolvedValue({ ...waiting, onboarding_complete: true, project_id: 'p1', has_events: true });
    const w = mount(Setup);
    await flushPromises();
    expect(w.get('[data-testid="setup-member"]').text()).toContain('Ask an organization admin to finish setup');
    expect(w.find('[data-testid="agent-paste-line"]').exists()).toBe(false);
    expect(api.completeOnboarding).not.toHaveBeenCalled();
    await advance();
    expect(api.completeOnboarding).not.toHaveBeenCalled();
    expect(routerPush).toHaveBeenCalledWith('/');
    w.unmount();
  });

  it('keeps members on their own screen when loading projects fails', async () => {
    api.getMe.mockResolvedValue({ active_role: 'member' });
    api.getOnboardingState.mockResolvedValue({ ...waiting, onboarding_complete: true, project_id: 'p1', has_events: true });
    api.listProjects.mockRejectedValueOnce(new Error('API 500'));
    const w = mount(Setup);
    await flushPromises();
    expect(w.get('[data-testid="setup-member"]').text()).toContain('Could not load your projects.');
    expect(w.find('[data-testid="agent-paste-line"]').exists()).toBe(false);
    await w.get('[data-testid="setup-retry-enter"]').trigger('click');
    await flushPromises();
    expect(routerPush).toHaveBeenCalledWith('/');
    w.unmount();
  });

  it.each([
    ['rejects', () => { api.listProjects.mockRejectedValueOnce(new Error('API 500')); }],
    ['is empty', () => { api.listProjects.mockResolvedValueOnce([]); }],
  ])('stays on setup with Try again when listing projects %s', async (_label, arrange) => {
    arrange();
    api.getOnboardingState.mockResolvedValue({ ...waiting, onboarding_complete: true, project_id: 'p1' });
    const w = mount(Setup);
    await flushPromises();
    expect(w.text()).toContain('Could not load your projects.');
    expect(routerPush).not.toHaveBeenCalled();
    expect(localStorage.getItem('opslane_project_id')).toBeNull();
    expect(localStorage.getItem('opslane_onboarding_complete')).toBeNull();
    await w.get('[data-testid="setup-retry-enter"]').trigger('click');
    await flushPromises();
    expect(routerPush).toHaveBeenCalledWith('/');
    w.unmount();
  });

  it('reads no setup state until the account loads', async () => {
    api.getMe.mockRejectedValueOnce(new Error('API 500')).mockResolvedValue({ active_role: 'admin' });
    const w = mount(Setup);
    await flushPromises();
    expect(w.text()).toContain('Could not load your account.');
    await advance(10_000);
    expect(api.getOnboardingState).not.toHaveBeenCalled();
    await w.get('[data-testid="setup-retry-account"]').trigger('click');
    await flushPromises();
    expect(api.getOnboardingState).toHaveBeenCalledTimes(1);
    w.unmount();
  });

  it.each(['account', 'state', 'complete', 'projects'] as const)('ignores a %s response that arrives after unmount', async (which) => {
    let release: () => void = () => undefined;
    function deferred<T>(value: T): Promise<T> {
      return new Promise<T>((resolve) => { release = () => resolve(value); });
    }
    const ready = { ...waiting, project_id: 'p1', has_events: true };
    api.getOnboardingState.mockResolvedValue(ready);
    if (which === 'account') api.getMe.mockImplementationOnce(() => deferred({ active_role: 'admin' }));
    if (which === 'state') api.getOnboardingState.mockImplementationOnce(() => deferred(ready));
    if (which === 'complete') api.completeOnboarding.mockImplementationOnce(() => deferred({ onboarding_complete: true }));
    if (which === 'projects') api.listProjects.mockImplementationOnce(() => deferred([{ id: 'p1', name: 'web' }]));
    const w = mount(Setup);
    await flushPromises();
    const stateCallsAtUnmount = api.getOnboardingState.mock.calls.length;
    w.unmount();
    release();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(10_000);
    // A leaked timer would keep polling here even though the generation guard
    // stops it writing anything, so assert the request count went flat.
    expect(api.getOnboardingState.mock.calls.length).toBe(stateCallsAtUnmount);
    expect(localStorage.getItem('opslane_onboarding_complete')).toBeNull();
    expect(localStorage.getItem('opslane_project_id')).toBeNull();
    expect(localStorage.getItem('opslane_project_name')).toBeNull();
    expect(routerPush).not.toHaveBeenCalled();
    if (which === 'account') expect(api.getOnboardingState).not.toHaveBeenCalled();
    if (which === 'state') expect(api.completeOnboarding).not.toHaveBeenCalled();
  });
});
