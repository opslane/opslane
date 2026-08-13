// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Incident, SampleEvent } from '../../types/api';

const api = vi.hoisted(() => {
  class APIError extends Error {
    constructor(public readonly status: number, message = '') {
      super(message);
    }
  }

  return {
    APIError,
    archiveIncident: vi.fn(),
    getIncident: vi.fn(),
    getReplay: vi.fn(),
    getSampleEvent: vi.fn(),
    getSession: vi.fn(),
    getSessionChunk: vi.fn(),
    listAffectedUsers: vi.fn(),
    resolveIncident: vi.fn(),
    triggerFix: vi.fn(),
    unarchiveIncident: vi.fn(),
  };
});

vi.mock('../../api', () => api);

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { id: 'i1' } }),
}));

import IncidentDetail from '../IncidentDetail.vue';

const incident: Incident = {
  id: 'i1',
  project_id: 'p1',
  kind: 'error',
  platform: 'python',
  fingerprint: 'valueerror:app.py:8',
  title: 'ValueError: boom',
  status: 'new',
  first_seen: '2026-07-19T00:00:00Z',
  last_seen: '2026-07-19T00:00:00Z',
  occurrence_count: 1,
  affected_users_count: 1,
  story: '1 crash; recording impact unavailable',
};

const sampleEvent: SampleEvent = {
  timestamp: '2026-07-19T00:00:00Z',
  platform: 'python',
  error: {
    type: 'ValueError',
    message: 'boom',
    stack: 'Traceback (most recent call last):\n  File "/app/api.py", line 8',
  },
  breadcrumbs: [{
    timestamp: '2026-07-19T00:00:00Z',
    type: 'log',
    category: 'app',
    level: 'warning',
    message: 'Near expiry',
  }],
  context: {
    request: {
      method: 'GET',
      path: '/users/42',
      remote_addr: '203.0.113.8',
      headers: { Accept: 'application/json' },
    },
  },
};

function mountView() {
  return mount(IncidentDetail, {
    global: {
      stubs: {
        ReplayPlayer: true,
        RouterLink: { template: '<a><slot /></a>' },
      },
    },
  });
}

describe('IncidentDetail sample event', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/issues/i1?project_id=p1');
    api.getIncident.mockResolvedValue(incident);
    api.getSampleEvent.mockResolvedValue(sampleEvent);
  });

  it('renders the traceback, request context, and breadcrumbs', async () => {
    const wrapper = mountView();
    await flushPromises();

    expect(api.getSampleEvent).toHaveBeenCalledWith('p1', 'i1');
    const section = wrapper.get('[data-testid="sample-event"]');
    expect(section.text()).toContain('Stack trace');
    expect(section.text()).toContain('Traceback (most recent call last)');
    expect(section.text()).toContain('Request');
    expect(section.text()).toContain('GET');
    expect(section.text()).toContain('/users/42');
    expect(section.text()).toContain('203.0.113.8');
    expect(section.text()).toContain('Accept');
    expect(section.text()).toContain('application/json');
    expect(section.text()).toContain('Breadcrumbs');
    expect(section.text()).toContain('log · app');
    expect(section.text()).toContain('Near expiry');

    wrapper.unmount();
  });

  it('keeps the page usable and omits the section when the sample event is absent', async () => {
    api.getSampleEvent.mockRejectedValue(new api.APIError(404, 'not found'));

    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.text()).toContain('ValueError: boom');
    expect(wrapper.find('[data-testid="sample-event"]').exists()).toBe(false);

    wrapper.unmount();
  });

  it('keeps the page usable and renders a local note on sample-event failure', async () => {
    api.getSampleEvent.mockRejectedValue(new api.APIError(500, 'server error'));

    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.text()).toContain('ValueError: boom');
    expect(wrapper.get('[data-testid="sample-event"]').text()).toContain(
      "Couldn't load stack trace.",
    );
    expect(wrapper.text()).not.toContain('Failed to load incident');

    wrapper.unmount();
  });

  it('does not request a sample event for friction incidents', async () => {
    api.getIncident.mockResolvedValue({ ...incident, kind: 'friction', platform: null });

    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.text()).toContain('ValueError: boom');
    expect(api.getSampleEvent).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="sample-event"]').exists()).toBe(false);

    wrapper.unmount();
  });

  it.each(['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>'])(
    'does not render an unsafe external trace URL: %s',
    async (traceUrl) => {
      api.getIncident.mockResolvedValue({ ...incident, trace_url: traceUrl });

      const wrapper = mountView();
      await flushPromises();

      expect(wrapper.find('a[href^="javascript:"]').exists()).toBe(false);
      expect(wrapper.find('a[href^="data:"]').exists()).toBe(false);
      expect(wrapper.text()).not.toContain('View in Langfuse');

      wrapper.unmount();
    },
  );

  it('renders a guarded HTTPS trace URL', async () => {
    api.getIncident.mockResolvedValue({ ...incident, trace_url: 'https://trace.example.test/i1' });

    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.get('a[href="https://trace.example.test/i1"]').attributes('rel')).toContain('noopener');

    wrapper.unmount();
  });
});
