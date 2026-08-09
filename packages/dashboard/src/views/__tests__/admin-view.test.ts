// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminOverview } from '../../types/api';

const api = vi.hoisted(() => ({
  getAdminOverview: vi.fn(),
  listAdminJobs: vi.fn(),
  getHealth: vi.fn(),
}));

vi.mock('../../api', () => ({
  APIError: class APIError extends Error {
    constructor(public status: number, message = '') {
      super(message);
    }
  },
  getAdminOverview: api.getAdminOverview,
  listAdminJobs: api.listAdminJobs,
  getHealth: api.getHealth,
}));

vi.mock('vue-router', () => ({
  useRouter: () => ({ replace: vi.fn() }),
}));

import AdminView from '../AdminView.vue';

const baseOverview: AdminOverview = {
  events: {
    last_1h: 0,
    last_24h: 0,
    last_7d: 0,
    hourly: [],
    top_projects: [],
  },
  jobs: {
    by_status: {},
    by_type: {},
    oldest_pending_age_seconds: null,
    dead_letters_7d: 0,
  },
  workers: { live_claims: 0, active_5m: 0 },
  outcomes: {
    by_status: {},
    pr_created_24h: 0,
    pr_created_7d: 0,
    needs_human_7d: 0,
    merged_7d: 0,
    closed_7d: 0,
    spend_usd_7d: 0,
    cost_per_merged_pr_7d: null,
  },
};

describe('AdminView onboarding funnel', () => {
  beforeEach(() => {
    api.getAdminOverview.mockReset();
    api.listAdminJobs.mockReset().mockResolvedValue({ jobs: [] });
    api.getHealth.mockReset().mockResolvedValue({
      status: 'ok',
      checks: {},
      version: 'test',
      uptime_seconds: 1,
    });
  });

  it('renders funnel stages, conversion, and failure reasons', async () => {
    api.getAdminOverview.mockResolvedValue({
      ...baseOverview,
      onboarding: {
        started: 10,
        auth_clicked: 8,
        completed: 6,
        key_claimed: 4,
        first_event_received: 3,
        failed: 2,
        by_failure_reason: { repo_not_granted: 2 },
      },
    });

    const wrapper = mount(AdminView);
    await flushPromises();

    const funnel = wrapper.get('[aria-label="Agent onboarding funnel"]');
    expect(funnel.text()).toContain('Agent onboarding (30d) · activation & best-effort');
    expect(funnel.text()).toContain('Started');
    expect(funnel.text()).toContain('Auth clicked');
    expect(funnel.text()).toContain('Completed');
    expect(funnel.text()).toContain('Key claimed');
    expect(funnel.text()).toContain('Project activated');
    expect(funnel.text()).toContain('80% of started');
    expect(funnel.text()).toContain('repo not granted: 2');

    wrapper.unmount();
  });

  it('supports overview responses from older servers without onboarding data', async () => {
    api.getAdminOverview.mockResolvedValue(baseOverview);

    const wrapper = mount(AdminView);
    await flushPromises();

    expect(wrapper.text()).toContain('System observability');
    expect(wrapper.find('[aria-label="Agent onboarding funnel"]').exists()).toBe(false);

    wrapper.unmount();
  });

  it('renders spend and cost per merged PR outcome tiles', async () => {
    api.getAdminOverview.mockResolvedValue(baseOverview);

    const wrapper = mount(AdminView);
    await flushPromises();

    const outcomesHeading = wrapper.findAll('h2').find((heading) => heading.text() === 'Incident outcomes');
    const outcomesCard = outcomesHeading?.element.parentElement;
    expect(outcomesCard?.textContent).toContain('Spend 7d');
    expect(outcomesCard?.textContent).toContain('$0.00');
    expect(outcomesCard?.textContent).toContain('Cost / merged PR 7d');
    expect(outcomesCard?.textContent).toContain('—');

    wrapper.unmount();
  });
});
