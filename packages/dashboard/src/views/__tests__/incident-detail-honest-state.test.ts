// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Incident } from '../../types/api';

const api = vi.hoisted(() => {
  class APIError extends Error { constructor(public readonly status: number) { super(); } }
  return {
    APIError,
    archiveIncident: vi.fn(), getIncident: vi.fn(), getReplay: vi.fn(), getSampleEvent: vi.fn(),
    getSession: vi.fn(), getSessionChunk: vi.fn(), listAffectedUsers: vi.fn(), resolveIncident: vi.fn(),
    triggerFix: vi.fn(), reinvestigateIncident: vi.fn(), unarchiveIncident: vi.fn(),
  };
});
vi.mock('../../api', () => api);
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { id: 'i1' } }) }));

import IncidentDetail from '../IncidentDetail.vue';

const base: Incident = {
  id: 'i1', project_id: 'p1', kind: 'error', fingerprint: 'fp', title: 'Crash',
  status: 'investigated', first_seen: '2026-08-11T00:00:00Z', last_seen: '2026-08-11T00:00:00Z',
  occurrence_count: 1, affected_users_count: 1, root_cause: 'placeholder',
  story: '1 crash; recording impact unavailable',
};

function mountView() {
  return mount(IncidentDetail, { global: { stubs: { ReplayPlayer: true, RouterLink: { template: '<a><slot /></a>' } } } });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/issues/i1?project_id=p1');
  api.getSampleEvent.mockRejectedValue(new api.APIError(404));
});

describe('IncidentDetail honest state', () => {
  it('requests reinvestigation when a ticket cause lacks current coverage', async () => {
    const ticket = { ...base, kind: 'friction', status: 'awaiting_approval', ticket_id: 't1',
      fix_substate: 'none', investigation_status: 'done', cause_coverage: 0.25 };
    api.getIncident.mockResolvedValueOnce(ticket).mockResolvedValue({ ...ticket, investigation_status: 'pending' });
    api.reinvestigateIncident.mockResolvedValue({ job_id: 'j1' });
    const wrapper = mountView();
    await flushPromises();
    expect(wrapper.text()).not.toContain('Create fix PR');
    await wrapper.findAll('button').find(button => button.text() === 'Reinvestigate')!.trigger('click');
    await flushPromises();
    expect(api.reinvestigateIncident).toHaveBeenCalledWith('p1', 'i1');
    expect(wrapper.text()).toContain('Investigation pending.');
    wrapper.unmount();
  });

  it('offers a fix for a ticket at half coverage and hides it while a PR is open', async () => {
    const ticket = { ...base, kind: 'friction', status: 'awaiting_approval', ticket_id: 't1',
      fix_substate: 'none', investigation_status: 'done', investigation_readiness: 'eligible', cause_coverage: 0.5 };
    api.getIncident.mockResolvedValue(ticket);
    let wrapper = mountView();
    await flushPromises();
    expect(wrapper.text()).toContain('Create fix PR');
    wrapper.unmount();
    api.getIncident.mockResolvedValue({ ...ticket, fix_substate: 'pr_open' });
    wrapper = mountView();
    await flushPromises();
    expect(wrapper.text()).not.toContain('Create fix PR');
    wrapper.unmount();
  });

  it('shows honest copy and no stored garbage when readiness is ineligible', async () => {
    api.getIncident.mockResolvedValue({ ...base, investigation_readiness: 'ineligible' });
    const wrapper = mountView();
    await flushPromises();
    expect(wrapper.get('[data-testid="honest-state"]').text()).toContain('Investigation has not verified a cause yet.');
    expect(wrapper.text()).not.toContain('placeholder');
    wrapper.unmount();
  });

  it('keeps legacy absent-row incidents rendering as before', async () => {
    api.getIncident.mockResolvedValue(base);
    const wrapper = mountView();
    await flushPromises();
    expect(wrapper.text()).toContain('placeholder');
    wrapper.unmount();
  });

  it('labels an eligible agent task brief as investigation output', async () => {
    api.getIncident.mockResolvedValue({
      ...base,
      investigation_readiness: 'eligible',
      agent_task_brief: 'Change src/App.vue and verify the save flow.',
    });
    const wrapper = mountView();
    await flushPromises();
    expect(wrapper.text()).toContain('Investigation output — agent task brief');
    expect(wrapper.text()).toContain('Change src/App.vue and verify the save flow.');
    wrapper.unmount();
  });
});
