// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Incident, PriorityInputs } from '../../types/api';

const mocks = vi.hoisted(() => ({
  listAccounts: vi.fn(),
  listEnvironments: vi.fn(),
  listIncidents: vi.fn(),
  replace: vi.fn(),
  route: { query: {} as Record<string, string> },
}));

vi.mock('../../api', () => ({
  listAccounts: mocks.listAccounts,
  listEnvironments: mocks.listEnvironments,
  listIncidents: mocks.listIncidents,
}));

vi.mock('vue-router', () => ({
  useRoute: () => mocks.route,
  useRouter: () => ({ replace: mocks.replace }),
}));

import IssuesList from '../IssuesList.vue';

function inputs(overrides: Partial<PriorityInputs> = {}): PriorityInputs {
  return {
    users_7d: 0,
    anon_sessions_7d: 0,
    users_24h: 0,
    anon_sessions_24h: 0,
    impact: 0,
    route_pattern: null,
    route_name: null,
    route_tier: null,
    route_weight: 1,
    cap_applied: false,
    reason_code: null,
    ...overrides,
  };
}

function incident(id: string, overrides: Partial<Incident> = {}): Incident {
  return {
    id,
    project_id: 'p1',
    kind: 'error',
    platform: 'javascript',
    fingerprint: `fingerprint-${id}`,
    title: `Issue ${id}`,
    status: 'new',
    first_seen: '2026-08-01T00:00:00Z',
    last_seen: '2026-08-01T00:00:00Z',
    occurrence_count: 1,
    affected_users_count: 1,
    story: '1 crash; recording impact unavailable',
    ...overrides,
  };
}

function mountFeed() {
  return mount(IssuesList, {
    global: {
      stubs: { RouterLink: { template: '<a><slot /></a>' } },
    },
  });
}

describe('IssuesList priority order', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.route.query = { project_id: 'p1' };
    window.history.replaceState({}, '', '/?project_id=p1');
    mocks.listAccounts.mockResolvedValue([]);
    mocks.listEnvironments.mockResolvedValue({ environments: [], rollup_ready: false });
  });

  it('defaults to priority order with last_seen tiebreak', async () => {
    mocks.listIncidents.mockResolvedValue([
      incident('zero-older', { priority_score: 0, last_seen: '2026-08-02T00:00:00Z' }),
      incident('unscored-newer', { last_seen: '2026-08-03T00:00:00Z' }),
      incident('top', { priority_score: 10 }),
      incident('middle', { priority_score: 0.5 }),
    ]);

    const wrapper = mountFeed();
    await flushPromises();

    expect(wrapper.findAll('tbody tr').map((row) => row.text())).toEqual([
      expect.stringContaining('Issue top'),
      expect.stringContaining('Issue middle'),
      expect.stringContaining('Issue unscored-newer'),
      expect.stringContaining('Issue zero-older'),
    ]);

    wrapper.unmount();
  });

  it('labels non-priority sorts as loaded-only', async () => {
    mocks.listIncidents.mockResolvedValue([incident('one', { priority_score: 1 })]);
    const wrapper = mountFeed();
    await flushPromises();

    expect(wrapper.text()).not.toContain('Sorting the loaded issues only');
    const lastSeenHeader = wrapper.findAll('thead th')
      .find((header) => header.text().includes('Last Seen'))!;
    await lastSeenHeader.get('button').trigger('click');

    expect(wrapper.text()).toContain(
      'Sorting the loaded issues only — the server feed is ordered by priority.',
    );

    wrapper.unmount();
  });

  it('can return to priority order from another sort via the Title header', async () => {
    mocks.listIncidents.mockResolvedValue([
      incident('top', { priority_score: 10, occurrence_count: 1 }),
      incident('noisy', { priority_score: 1, occurrence_count: 999 }),
    ]);
    const wrapper = mountFeed();
    await flushPromises();

    const headerFor = (label: string) => wrapper.findAll('thead th')
      .find((header) => header.text().includes(label))!;

    await headerFor('Events').get('button').trigger('click');
    expect(wrapper.findAll('tbody tr')[0]?.text()).toContain('Issue noisy');

    // Desktop's only route back to the server's own ordering.
    await headerFor('Title').get('button').trigger('click');
    expect(wrapper.findAll('tbody tr')[0]?.text()).toContain('Issue top');
    expect(headerFor('Title').attributes('aria-sort')).toBe('descending');
    expect(wrapper.text()).not.toContain('Sorting the loaded issues only');

    wrapper.unmount();
  });

  it('renders PriorityReason per row with environment and identify props wired', async () => {
    mocks.route.query = { project_id: 'p1', environment_id: 'production' };
    window.history.replaceState(
      {},
      '',
      '/?project_id=p1&environment_id=production',
    );
    mocks.listEnvironments.mockResolvedValue({
      environments: [
        { id: 'production', project_id: 'p1', name: 'Production', created_at: '' },
        { id: 'staging', project_id: 'p1', name: 'Staging', created_at: '' },
      ],
      rollup_ready: true,
    });
    mocks.listIncidents.mockResolvedValue([
      incident('identified', {
        priority_score: 8,
        priority_scored_at: '2026-08-07T01:00:00Z',
        priority_inputs: inputs({ users_7d: 8, impact: 8 }),
      }),
      incident('anonymous', {
        priority_score: 4,
        priority_scored_at: '2026-08-07T01:00:00Z',
        priority_inputs: inputs({ anon_sessions_7d: 4, impact: 4 }),
      }),
    ]);

    const wrapper = mountFeed();
    await flushPromises();

    const anonymousRow = wrapper.findAll('tbody tr')
      .find((row) => row.text().includes('Issue anonymous'))!;
    expect(anonymousRow.text()).toContain('4 anonymous sessions this week · project-wide');
    expect(anonymousRow.text())
      .toContain('identify() is wired elsewhere in your app but not on this page.');
    expect(mocks.listIncidents).toHaveBeenLastCalledWith('p1', {
      environment_id: 'production',
    });

    wrapper.unmount();
  });
});
