// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import type { AgentApproveInfo, AgentFacts } from '../../types/api';

const api = vi.hoisted(() => ({
  getAgentApproveInfo: vi.fn(),
  getMe: vi.fn(),
  approveAgentSession: vi.fn(),
  denyAgentSession: vi.fn(),
}));
vi.mock('../../api', () => api);
const routerPush = vi.fn();
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: routerPush }),
  useRoute: () => ({ params: { id: 'sess-1' } }),
}));

import AgentApprove, { deriveChecklist } from '../AgentApprove.vue';

const emptyFacts: AgentFacts = {
  has_events: false, latest_error_group_url: null, issues_url: 'http://x/', github_connected: false, github_installed: false,
  github_mode: 'app', github_connect_url: 'http://x/settings#github', github_repo: null, slack_connected: false,
  sourcemaps_uploaded: false, steps: {},
};

function pending(overrides: Partial<AgentApproveInfo> = {}): AgentApproveInfo {
  return {
    status: 'pending', agent_name: 'Claude Code on box', project_name: 'acme-web', git_remote: 'acme/web',
    expires_at: '2030-01-01T00:00:00Z',
    projects: [{ id: 'p-old', name: 'Old', github_repo: 'acme/web' }, { id: 'p-2', name: 'Other', github_repo: null }],
    suggested_project_id: 'p-old',
    ...overrides,
  };
}

const statuses = (w: ReturnType<typeof mount>) => w.findAll('[data-testid^="step-"]').map((r) => r.attributes('data-status'));

describe('AgentApprove', () => {
  beforeEach(() => { vi.resetAllMocks(); sessionStorage.clear(); localStorage.clear(); });
  afterEach(() => { vi.useRealTimers(); });

  it('shows the whole checklist before approval, preselects the matching project, and approves as attach', async () => {
    api.getAgentApproveInfo.mockResolvedValue(pending());
    api.approveAgentSession.mockResolvedValue({ status: 'provisioned', project_id: 'p-old', project_name: 'Old' });
    const w = mount(AgentApprove, { global: { stubs: { RouterLink: true } } });
    await flushPromises();
    expect(w.text()).toContain('Claude Code on box');
    expect(statuses(w)).toEqual(['running', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending']);
    expect(w.find('input[type="radio"]:checked').attributes('value')).toBe('p-old');
    await w.find('[data-testid="agent-approve-button"]').trigger('click');
    await flushPromises();
    expect(api.approveAgentSession).toHaveBeenCalledWith('sess-1', { existing_project_id: 'p-old' });
    w.unmount();
  });

  it('creates a new project when no repo matches, using the typed name', async () => {
    api.getAgentApproveInfo.mockResolvedValue(pending({ suggested_project_id: null, projects: [] }));
    api.approveAgentSession.mockResolvedValue({ status: 'provisioned', project_id: 'p-new', project_name: 'Acme Web' });
    const w = mount(AgentApprove, { global: { stubs: { RouterLink: true } } });
    await flushPromises();
    await w.find('[data-testid="agent-project-name"]').setValue('Acme Web');
    await w.find('[data-testid="agent-approve-button"]').trigger('click');
    await flushPromises();
    expect(api.approveAgentSession).toHaveBeenCalledWith('sess-1', { project_name: 'Acme Web' });
    w.unmount();
  });

  it('decline marks the session failed and says so', async () => {
    api.getAgentApproveInfo.mockResolvedValue(pending());
    api.denyAgentSession.mockResolvedValue({ status: 'failed' });
    const w = mount(AgentApprove, { global: { stubs: { RouterLink: true } } });
    await flushPromises();
    await w.find('[data-testid="agent-deny-button"]').trigger('click');
    await flushPromises();
    expect(api.denyAgentSession).toHaveBeenCalledWith('sess-1');
    expect(w.text()).toContain('declined');
    expect(statuses(w)[0]).toBe('failed');
    w.unmount();
  });

  it('polls while the picker is open and reacts to approval from another tab', async () => {
    vi.useFakeTimers();
    api.getAgentApproveInfo
      .mockResolvedValueOnce(pending())
      .mockResolvedValue(pending({ status: 'provisioned', facts: emptyFacts }));
    const w = mount(AgentApprove, { global: { stubs: { RouterLink: true } } });
    await flushPromises();
    expect(w.find('[data-testid="agent-approve-button"]').exists()).toBe(true);
    await vi.advanceTimersByTimeAsync(3100);
    await flushPromises();
    expect(w.find('[data-testid="agent-approve-button"]').exists()).toBe(false);
    expect(statuses(w)[0]).toBe('done');
    w.unmount();
  });

  it('serializes refreshes and discards a refresh after decline', async () => {
    vi.useFakeTimers();
    let resolveLate: (v: AgentApproveInfo) => void = () => undefined;
    api.getAgentApproveInfo
      .mockResolvedValueOnce(pending())
      .mockImplementationOnce(() => new Promise<AgentApproveInfo>((res) => { resolveLate = res; }));
    api.denyAgentSession.mockResolvedValue({ status: 'failed' });
    const w = mount(AgentApprove, { global: { stubs: { RouterLink: true } } });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(3100);
    await vi.advanceTimersByTimeAsync(9000);
    expect(api.getAgentApproveInfo).toHaveBeenCalledTimes(2);
    await w.get('[data-testid="agent-deny-button"]').trigger('click');
    await flushPromises();
    resolveLate(pending({ status: 'provisioned', facts: emptyFacts }));
    await flushPromises();
    expect(w.text()).toContain('declined');
    expect(statuses(w)[0]).toBe('failed');
    await vi.advanceTimersByTimeAsync(10000);
    expect(api.getAgentApproveInfo).toHaveBeenCalledTimes(2);
    w.unmount();
  });

  it.each(['refresh', 'approve', 'deny'])('does not restart polling after unmount during %s', async (operation) => {
    vi.useFakeTimers();
    let resolveLate: () => void = () => undefined;
    api.getAgentApproveInfo.mockResolvedValue(pending());
    const w = mount(AgentApprove, { global: { stubs: { RouterLink: true } } });
    await flushPromises();
    if (operation === 'refresh') {
      api.getAgentApproveInfo.mockImplementationOnce(() => new Promise<AgentApproveInfo>((resolve) => {
        resolveLate = () => resolve(pending({ status: 'provisioned', facts: emptyFacts }));
      }));
      await vi.advanceTimersByTimeAsync(3100);
    } else {
      const action = operation === 'approve' ? api.approveAgentSession : api.denyAgentSession;
      action.mockImplementationOnce(() => new Promise((resolve) => {
        resolveLate = () => resolve({ status: operation === 'approve' ? 'provisioned' : 'failed', project_name: 'Old' });
      }));
      await w.get(`[data-testid="agent-${operation}-button"]`).trigger('click');
    }
    w.unmount();
    const calls = api.getAgentApproveInfo.mock.calls.length;
    resolveLate();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(10000);
    expect(api.getAgentApproveInfo).toHaveBeenCalledTimes(calls);
  });

  it('renders agent notes as text and rejects unsafe issue links', async () => {
    api.getAgentApproveInfo.mockResolvedValue(pending({ status: 'completed', project_id: 'p-old', facts: {
      ...emptyFacts, latest_error_group_url: 'javascript:alert(1)',
      steps: { mcp: { status: 'failed', note: '<img src=x onerror=alert(1)>', updated_at: '' } },
    } }));
    const w = mount(AgentApprove, { global: { stubs: { RouterLink: true } } });
    await flushPromises();
    expect(w.text()).toContain('<img src=x onerror=alert(1)>');
    expect(w.find('img').exists()).toBe(false);
    expect(w.find('[data-testid="agent-latest-issue"]').exists()).toBe(false);
    w.unmount();
  });

  it('refreshes the checklist after approval and applies terminal states from polling', async () => {
    vi.useFakeTimers();
    api.getAgentApproveInfo
      .mockResolvedValueOnce(pending())
      .mockResolvedValueOnce(pending({ status: 'provisioned', facts: emptyFacts }))
      .mockResolvedValueOnce(pending({
        status: 'key_ok',
        facts: { ...emptyFacts, has_events: true, latest_error_group_url: 'http://x/issues/g1',
          steps: { install_sdk: { status: 'done', note: 'vite', updated_at: '' }, mcp: { status: 'skipped', note: 'headless', updated_at: '' } } },
      }))
      .mockResolvedValue(pending({ status: 'expired' }));
    api.approveAgentSession.mockResolvedValue({ status: 'provisioned', project_id: 'p-old', project_name: 'Old' });
    const w = mount(AgentApprove, { global: { stubs: { RouterLink: true } } });
    await flushPromises();
    await w.find('[data-testid="agent-approve-button"]').trigger('click');
    await flushPromises();
    expect(statuses(w)).toEqual(['done', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending']);
    await vi.advanceTimersByTimeAsync(3100);
    await flushPromises();
    expect(statuses(w)).toEqual(['done', 'done', 'done', 'pending', 'pending', 'pending', 'skipped']);
    expect(w.find('[data-testid="agent-latest-issue"]').attributes('href')).toBe('http://x/issues/g1?project_id=p-old');
    await vi.advanceTimersByTimeAsync(3100);
    await flushPromises();
    expect(w.text()).toContain('expired');
    const calls = api.getAgentApproveInfo.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6500);
    expect(api.getAgentApproveInfo.mock.calls.length).toBe(calls); // polling stopped on a terminal state
    w.unmount();
  });

  it.each(['approve', 'revisit'])('opens project B dashboard after %s while project A was selected', async (mode) => {
    localStorage.setItem('opslane_project_id', 'p-a');
    localStorage.setItem('opslane_environment_id', 'env-a');
    api.getMe.mockResolvedValue({ onboarding_complete: true });
    const projects = [{ id: 'p-a', name: 'A', github_repo: null }, { id: 'p-b', name: 'B', github_repo: 'acme/web' }];
    const approved = pending({ status: 'provisioned', project_id: 'p-b', project_name: 'B', projects, facts: emptyFacts });
    if (mode === 'approve') {
      api.getAgentApproveInfo.mockResolvedValueOnce(pending({ projects, suggested_project_id: 'p-b' })).mockResolvedValue(approved);
      api.approveAgentSession.mockResolvedValue({ status: 'provisioned', project_id: 'p-b', project_name: 'B' });
    } else {
      api.getAgentApproveInfo.mockResolvedValue(approved);
    }
    const w = mount(AgentApprove, { global: { stubs: { RouterLink: true } } });
    await flushPromises();
    if (mode === 'approve') {
      await w.get('[data-testid="agent-approve-button"]').trigger('click');
      await flushPromises();
    }
    expect(localStorage.getItem('opslane_project_id')).toBe('p-a');
    await w.get('[data-testid="agent-dashboard"]').trigger('click');
    await flushPromises();
    expect(api.getMe).toHaveBeenCalledTimes(1);
    expect(routerPush).toHaveBeenCalledWith('/?project_id=p-b');
    expect(localStorage.getItem('opslane_project_id')).toBe('p-b');
    expect(localStorage.getItem('opslane_environment_id')).toBeNull();
    w.unmount();
  });

  it('refreshes a fresh account completion cache before opening the exact test error in B', async () => {
    localStorage.setItem('opslane_project_id', 'p-a');
    api.getAgentApproveInfo.mockResolvedValue(pending({ status: 'completed', project_id: 'p-b', facts: {
      ...emptyFacts, has_events: true, latest_error_group_url: 'http://x/issues/g-b?project_id=p-b#evidence',
    } }));
    let finishCheck: (value: { onboarding_complete: boolean }) => void = () => undefined;
    api.getMe.mockImplementation(() => new Promise((resolve) => { finishCheck = resolve; }));
    const w = mount(AgentApprove, { global: { stubs: { RouterLink: true } } });
    await flushPromises();
    await w.get('[data-testid="agent-latest-issue"]').trigger('click');
    expect(routerPush).not.toHaveBeenCalled();
    expect(localStorage.getItem('opslane_onboarding_complete')).toBeNull();
    finishCheck({ onboarding_complete: true });
    await flushPromises();
    expect(localStorage.getItem('opslane_onboarding_complete')).toBe('1');
    expect(routerPush).toHaveBeenCalledWith('/issues/g-b?project_id=p-b#evidence');
    expect(localStorage.getItem('opslane_project_id')).toBe('p-b');
    w.unmount();
  });

  it('preserves the error destination while setup is pending, then rechecks before opening it', async () => {
    localStorage.setItem('opslane_onboarding_complete', '1');
    api.getAgentApproveInfo.mockResolvedValue(pending({ status: 'app_reporting', project_id: 'p-b', facts: {
      ...emptyFacts, has_events: true, latest_error_group_url: 'http://x/issues/g-b',
    } }));
    api.getMe.mockResolvedValueOnce({ onboarding_complete: false }).mockResolvedValue({ onboarding_complete: true });
    const w = mount(AgentApprove, { global: { stubs: { RouterLink: true } } });
    await flushPromises();
    await w.get('[data-testid="agent-latest-issue"]').trigger('click');
    await flushPromises();
    expect(routerPush).not.toHaveBeenCalled();
    expect(localStorage.getItem('opslane_onboarding_complete')).toBeNull();
    expect(w.text()).toContain('Your agent is still finishing setup');
    await w.get('[data-testid="agent-navigation-retry"]').trigger('click');
    await flushPromises();
    expect(api.getMe).toHaveBeenCalledTimes(2);
    expect(routerPush).toHaveBeenCalledWith('/issues/g-b?project_id=p-b');
    w.unmount();
  });

  it('does not navigate or update caches when the status check finishes after unmount', async () => {
    api.getAgentApproveInfo.mockResolvedValue(pending({ status: 'completed', project_id: 'p-b' }));
    let finishCheck: (value: { onboarding_complete: boolean }) => void = () => undefined;
    api.getMe.mockImplementation(() => new Promise((resolve) => { finishCheck = resolve; }));
    const w = mount(AgentApprove, { global: { stubs: { RouterLink: true } } });
    await flushPromises();
    await w.get('[data-testid="agent-dashboard"]').trigger('click');
    w.unmount();
    finishCheck({ onboarding_complete: true });
    await flushPromises();
    expect(routerPush).not.toHaveBeenCalled();
    expect(localStorage.getItem('opslane_onboarding_complete')).toBeNull();
  });

  it.each(['failed', 'expired', 'completed'] as const)('stops picker polling on %s', async (status) => {
    vi.useFakeTimers();
    api.getAgentApproveInfo.mockResolvedValueOnce(pending()).mockResolvedValue(pending({ status }));
    const w = mount(AgentApprove, { global: { stubs: { RouterLink: true } } });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(3100);
    expect(w.find('[data-testid="agent-approve-button"]').exists()).toBe(false);
    await vi.advanceTimersByTimeAsync(10000);
    expect(api.getAgentApproveInfo).toHaveBeenCalledTimes(2);
    w.unmount();
  });

  it('a session that is already approved on load goes straight to the checklist', async () => {
    api.getAgentApproveInfo.mockResolvedValue(pending({ status: 'app_reporting', facts: emptyFacts }));
    const w = mount(AgentApprove, { global: { stubs: { RouterLink: true } } });
    await flushPromises();
    expect(w.find('[data-testid="agent-approve-button"]').exists()).toBe(false);
    expect(statuses(w)[0]).toBe('done');
    w.unmount();
  });
});

describe('deriveChecklist', () => {
  it('lets server facts override agent reports and keeps agent failure notes', () => {
    const info = pending({
      status: 'app_reporting',
      facts: { ...emptyFacts, has_events: true, github_connected: true, github_installed: true, github_repo: 'acme/web',
        steps: { install_sdk: { status: 'done', note: '', updated_at: '' }, sourcemaps: { status: 'failed', note: 'no CI access', updated_at: '' }, mcp: { status: 'skipped', note: 'headless', updated_at: '' } } },
    });
    const list = deriveChecklist(info);
    expect(list.map((s) => `${s.step}:${s.status}`)).toEqual([
      'approve:done', 'install_sdk:done', 'first_event:done', 'github:done', 'slack:pending', 'sourcemaps:failed', 'mcp:skipped',
    ]);
    expect(list.find((s) => s.step === 'sourcemaps')?.note).toBe('no CI access');
  });
  it('honours a reported first_event failure until the server fact overrides it', () => {
    const reported = pending({ status: 'key_ok', facts: { ...emptyFacts, steps: { install_sdk: { status: 'done', note: '', updated_at: '' }, first_event: { status: 'failed', note: 'CSP blocked', updated_at: '' } } } });
    expect(deriveChecklist(reported).find((s) => s.step === 'first_event')).toMatchObject({ status: 'failed', note: 'CSP blocked' });
    const overridden = pending({ status: 'key_ok', facts: { ...reported.facts!, has_events: true } });
    expect(deriveChecklist(overridden).find((s) => s.step === 'first_event')?.status).toBe('done');
  });
  it('marks approve failed on a declined session', () => {
    expect(deriveChecklist(pending({ status: 'failed' }))[0]).toMatchObject({ step: 'approve', status: 'failed' });
  });
});
