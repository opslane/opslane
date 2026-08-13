// @vitest-environment jsdom

import { defineComponent } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Incident } from '../../types/api';

const api = vi.hoisted(() => {
  class APIError extends Error { constructor(public readonly status: number) { super(); } }
  return {
    APIError,
    archiveIncident: vi.fn(), getIncident: vi.fn(), getReplay: vi.fn(), getSampleEvent: vi.fn(),
    getSession: vi.fn(), getSessionChunk: vi.fn(), listAffectedUsers: vi.fn(), resolveIncident: vi.fn(),
    triggerFix: vi.fn(), unarchiveIncident: vi.fn(),
  };
});
vi.mock('../../api', () => api);
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { id: 'i1' } }) }));

import IncidentDetail from '../IncidentDetail.vue';

const RouterLink = defineComponent({
  name: 'RouterLink',
  props: { to: { type: [String, Object], required: true } },
  template: '<a data-router-link><slot /></a>',
});

const base: Incident = {
  id: 'i1', project_id: 'p1', kind: 'error', fingerprint: 'fp', title: 'Checkout crash',
  status: 'investigated', first_seen: '2026-08-11T00:00:00Z', last_seen: '2026-08-11T00:00:00Z',
  occurrence_count: 12, affected_users_count: 3, investigation_readiness: 'eligible',
  root_cause: 'Profile lookup returned null.',
  agent_task_brief: 'Guard the profile lookup and run checkout tests.',
  story: '12 crashes across 3 visits, 1 of 3 visits recovered',
  impact_class: 'degraded', impact_visits: 3, impact_visits_recovered: 1,
  recordings: [{
    session_id: 's-1', started_at: '2026-08-11T00:00:00Z', duration_ms: 36000,
    crash_count: 1, anchor_ms: 1786406400000,
  }, {
    session_id: 's-2', started_at: '2026-08-11T00:01:00Z', duration_ms: 42000,
    crash_count: 2, anchor_ms: 1786406460000,
  }],
};

function mountView(incident: Incident) {
  api.getIncident.mockResolvedValue(incident);
  return mount(IncidentDetail, { global: { stubs: { ReplayPlayer: true, RouterLink } } });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/issues/i1?project_id=p1');
  api.getSampleEvent.mockResolvedValue({
    timestamp: '2026-08-11T00:00:00Z', platform: 'javascript',
    error: { type: 'TypeError', message: 'boom', stack: 'at checkout' },
    breadcrumbs: [], context: {},
  });
});

describe('IncidentDetail receipts', () => {
  it('renders a PR receipt once and preserves the impact-first order', async () => {
    const wrapper = mountView({
      ...base, status: 'pr_created', receipt_state: 'pr_open',
      receipt_line: 'Fix PR ready for review.', pr_url: 'https://github.com/opslane/app/pull/7',
    });
    await flushPromises();
    expect(wrapper.get('[data-testid="receipt-line"]').text()).toBe('Fix PR ready for review.');
    expect(wrapper.findAll('a[href="https://github.com/opslane/app/pull/7"]')).toHaveLength(1);
    const html = wrapper.html();
    expect(html.indexOf('data-testid="impact-badge"')).toBeLessThan(html.indexOf('data-testid="story"'));
    expect(html.indexOf('data-testid="story"')).toBeLessThan(html.indexOf('data-testid="recordings"'));
    expect(html.indexOf('data-testid="recordings"')).toBeLessThan(html.indexOf('data-testid="root-cause"'));
    expect(html.indexOf('data-testid="root-cause"')).toBeLessThan(html.indexOf('data-testid="receipt"'));
    expect(html.indexOf('data-testid="receipt"')).toBeLessThan(html.indexOf('data-testid="sample-event"'));
    wrapper.unmount();
  });

  it.each([
    ['attempt_failed_with_diff', 'Fix attempt failed its checks; the working diff was saved.'],
    ['attempt_failed_no_diff', 'Fix attempt failed before producing a change.'],
    ['report_ready', 'Investigation report ready.'],
  ] as const)('renders the %s receipt', async (receiptState, receiptLine) => {
    const wrapper = mountView({
      ...base,
      status: receiptState === 'report_ready' ? 'investigated' : 'needs_human',
      receipt_state: receiptState,
      receipt_line: receiptLine,
      candidate_diff: receiptState === 'attempt_failed_with_diff' ? 'diff --git a/x b/x' : undefined,
      reason: receiptState.startsWith('attempt_failed')
        ? { reason_code: 'tests_failed', reason_message: 'Checks failed.', remediation: 'Review the saved work.' }
        : undefined,
    });
    await flushPromises();
    expect(wrapper.get('[data-testid="receipt-line"]').text()).toBe(receiptLine);
    if (receiptState === 'attempt_failed_with_diff') expect(wrapper.get('[data-testid="receipt"] pre').text()).toContain('diff --git');
    if (receiptState === 'attempt_failed_no_diff') expect(wrapper.get('[data-testid="receipt"]').text()).toContain('Checks failed.');
    if (receiptState === 'report_ready') {
      expect(wrapper.text()).toContain('Guard the profile lookup');
      expect(wrapper.text()).toContain('Find Fix');
    }
    wrapper.unmount();
  });

  it('withholds receipt framing but keeps safe artifact facts and honest state', async () => {
    const wrapper = mountView({
      ...base, status: 'pr_created', investigation_readiness: 'ineligible', root_cause: undefined,
      agent_task_brief: undefined, receipt_state: undefined, receipt_line: undefined,
      pr_url: 'https://github.com/opslane/app/pull/8',
    });
    await flushPromises();
    expect(wrapper.find('[data-testid="receipt"]').exists()).toBe(false);
    expect(wrapper.findAll('a[href="https://github.com/opslane/app/pull/8"]')).toHaveLength(1);
    expect(wrapper.get('[data-testid="honest-state"]').text()).toContain('Investigation has not verified a cause yet.');
    wrapper.unmount();
  });

  it('renders the unavailable story without a badge and rejects unsafe PR URLs', async () => {
    const wrapper = mountView({
      ...base, impact_class: undefined, impact_visits: undefined, impact_visits_recovered: undefined,
      story: '12 crashes; recording impact unavailable', pr_url: 'javascript:alert(1)',
      receipt_state: undefined, receipt_line: undefined,
    });
    await flushPromises();
    expect(wrapper.get('[data-testid="story"]').text()).toBe('12 crashes; recording impact unavailable');
    expect(wrapper.find('[data-testid="impact-badge"]').exists()).toBe(false);
    expect(wrapper.find('a[href^="javascript:"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('keeps the honest-state reason without inventing receipt framing', async () => {
    const wrapper = mountView({
      ...base,
      status: 'needs_human',
      investigation_readiness: 'ineligible',
      root_cause: undefined,
      agent_task_brief: undefined,
      receipt_state: undefined,
      receipt_line: undefined,
      reason: {
        reason_code: 'verification_infra_error',
        reason_message: 'Verification infrastructure was unavailable.',
        remediation: 'Retry after the runner recovers.',
      },
    });
    await flushPromises();
    expect(wrapper.find('[data-testid="receipt"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="honest-state"]').text()).toContain('Investigation has not verified a cause yet.');
    expect(wrapper.text()).toContain('Verification infrastructure was unavailable.');
    wrapper.unmount();
  });

  it('passes the full seek query to each recording link', async () => {
    const wrapper = mountView(base);
    await flushPromises();
    const watch = wrapper.findAllComponents(RouterLink).find((link) => link.text() === 'Watch');
    expect(watch?.props('to')).toEqual({
      name: 'session-detail', params: { sessionId: 's-1' },
      query: { t: 1786406400000, project_id: 'p1' },
    });
    expect(wrapper.findAllComponents(RouterLink).filter((link) => link.text() === 'Watch')).toHaveLength(2);
    expect(wrapper.get('[data-testid="recordings"]').text()).toContain('1 crash');
    expect(wrapper.get('[data-testid="recordings"]').text()).toContain('2 crashes');
    wrapper.unmount();
  });
});

describe('IncidentDetail artifact visibility (review fixes)', () => {
  it('keeps the saved diff visible when readiness withholds receipt framing', async () => {
    const wrapper = mountView({
      ...base,
      status: 'needs_human',
      investigation_readiness: 'ineligible',
      root_cause: undefined,
      agent_task_brief: undefined,
      receipt_state: undefined,
      receipt_line: undefined,
      candidate_diff: 'diff --git a/x.ts b/x.ts\n-old\n+new',
      reason: { reason_code: 'tests_failed', reason_message: 'Red suite.', remediation: 'Review manually.' },
    });
    await flushPromises();
    // The diff is a preserved artifact fact (C2 AC2.10): no receipt framing,
    // but the diff and reason still render.
    expect(wrapper.find('[data-testid="receipt"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="candidate-diff-card"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('diff --git a/x.ts');
    expect(wrapper.find('[data-testid="attempt-reason-card"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('states an off-policy PR host as plain text instead of hiding the receipt artifact', async () => {
    const wrapper = mountView({
      ...base,
      status: 'pr_created',
      pr_url: 'https://ghe.corp.example/org/repo/pull/9',
      receipt_state: 'pr_open',
      receipt_line: 'Fix PR ready for review.',
    });
    await flushPromises();
    const card = wrapper.find('[data-testid="pr-link-card"]');
    expect(card.exists()).toBe(true);
    // No anchor for an off-policy host, but the URL itself stays readable.
    expect(card.find('a').exists()).toBe(false);
    expect(card.text()).toContain('https://ghe.corp.example/org/repo/pull/9');
    wrapper.unmount();
  });
});
