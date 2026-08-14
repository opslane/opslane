// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  createNotificationDestination: vi.fn(),
  deleteNotificationDestination: vi.fn(),
  listNotificationDestinations: vi.fn(),
  testNotificationDestination: vi.fn(),
  updateNotificationDestination: vi.fn(),
}));

vi.mock('../../api', () => api);

import IntegrationsSettings from '../../components/IntegrationsSettings.vue';

const destination = (id: string, name: string) => ({
  id,
  type: 'slack' as const,
  name,
  config_fingerprint: 'hooks.slack.com/…/****part',
  event_types: ['issue.created'],
  delivery_policy: 'immediate' as const,
  enabled: true,
  created_at: '2026-07-19T00:00:00Z',
  last_delivery: null,
  recent_failures: 0,
});

describe('IntegrationsSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listNotificationDestinations.mockResolvedValue({
      can_manage: true,
      destinations: [],
    });
  });

  it('refetches destinations when the project changes', async () => {
    const wrapper = mount(IntegrationsSettings, { props: { projectId: 'project-a' } });
    await flushPromises();

    expect(api.listNotificationDestinations).toHaveBeenCalledWith('project-a');

    await wrapper.setProps({ projectId: 'project-b' });
    await flushPromises();

    expect(api.listNotificationDestinations).toHaveBeenLastCalledWith('project-b');
    expect(api.listNotificationDestinations).toHaveBeenCalledTimes(2);
  });

  it('does not let a slower response from the previous project replace current data', async () => {
    let resolveA!: (value: object) => void;
    let resolveB!: (value: object) => void;
    api.listNotificationDestinations.mockImplementation((projectId: string) => (
      new Promise((resolve) => {
        if (projectId === 'project-a') resolveA = resolve;
        if (projectId === 'project-b') resolveB = resolve;
      })
    ));

    const wrapper = mount(IntegrationsSettings, { props: { projectId: 'project-a' } });
    await wrapper.setProps({ projectId: 'project-b' });
    resolveB({ can_manage: true, destinations: [destination('b', 'Project B alerts')] });
    await flushPromises();

    expect(wrapper.text()).toContain('Project B alerts');

    resolveA({ can_manage: true, destinations: [destination('a', 'Project A alerts')] });
    await flushPromises();

    expect(wrapper.text()).toContain('Project B alerts');
    expect(wrapper.text()).not.toContain('Project A alerts');
  });

  it('renders no mutation controls when the server denies management', async () => {
    api.listNotificationDestinations.mockResolvedValue({
      can_manage: false,
      destinations: [destination('readonly', 'Read-only alerts')],
    });

    const wrapper = mount(IntegrationsSettings, { props: { projectId: 'project-a' } });
    await flushPromises();

    expect(wrapper.text()).toContain('Read-only alerts');
    expect(wrapper.find('[data-testid="add-slack-form"]').exists()).toBe(false);
    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false);
    expect(wrapper.findAll('button')).toHaveLength(0);
    expect(wrapper.text()).not.toContain('Test');
    expect(wrapper.text()).not.toContain('Delete');
  });

  it('shows subscriptions and keeps the final event type selected', async () => {
    api.listNotificationDestinations.mockResolvedValue({
      can_manage: true,
      destinations: [destination('destination-1', 'Production alerts')],
    });

    const wrapper = mount(IntegrationsSettings, { props: { projectId: 'project-a' } });
    await flushPromises();

    const issueAlerts = wrapper.get('input[aria-label="New issue alerts for Production alerts"]');
    const dailyDigest = wrapper.get('input[aria-label="Daily digest for Production alerts"]');
    expect((issueAlerts.element as HTMLInputElement).checked).toBe(true);
    expect(issueAlerts.attributes('disabled')).toBeDefined();
    expect((dailyDigest.element as HTMLInputElement).checked).toBe(false);
    expect(dailyDigest.attributes('disabled')).toBeUndefined();
  });

  it('updates a destination subscription from its event type checkbox', async () => {
    api.listNotificationDestinations.mockResolvedValue({
      can_manage: true,
      destinations: [destination('destination-1', 'Production alerts')],
    });
    api.updateNotificationDestination.mockResolvedValue({
      ...destination('destination-1', 'Production alerts'),
      event_types: ['issue.created', 'digest.daily'],
    });

    const wrapper = mount(IntegrationsSettings, { props: { projectId: 'project-a' } });
    await flushPromises();

    await wrapper.get('input[aria-label="Daily digest for Production alerts"]').setValue(true);
    await flushPromises();

    expect(api.updateNotificationDestination).toHaveBeenCalledWith(
      'project-a',
      'destination-1',
      { event_types: ['issue.created', 'digest.daily'] },
    );
  });

  it('updates when a new issue alert is delivered', async () => {
    api.listNotificationDestinations.mockResolvedValue({
      can_manage: true,
      destinations: [destination('destination-1', 'Production alerts')],
    });
    api.updateNotificationDestination.mockResolvedValue({
      ...destination('destination-1', 'Production alerts'),
      delivery_policy: 'post_triage',
    });

    const wrapper = mount(IntegrationsSettings, { props: { projectId: 'project-a' } });
    await flushPromises();
    await wrapper.get('input[aria-label="Alert after triage for Production alerts"]').setValue(true);
    await flushPromises();

    expect(api.updateNotificationDestination).toHaveBeenCalledWith(
      'project-a',
      'destination-1',
      { delivery_policy: 'post_triage' },
    );
  });

  it('sends a digest preview for a destination', async () => {
    api.listNotificationDestinations.mockResolvedValue({
      can_manage: true,
      destinations: [destination('destination-1', 'Production alerts')],
    });
    api.testNotificationDestination.mockResolvedValue({
      ok: true,
      classification: 'delivered',
      status_code: 200,
    });

    const wrapper = mount(IntegrationsSettings, { props: { projectId: 'project-a' } });
    await flushPromises();

    const preview = wrapper.findAll('button').find((button) => button.text() === 'Send digest preview');
    expect(preview).toBeDefined();
    await preview!.trigger('click');
    await flushPromises();

    expect(api.testNotificationDestination).toHaveBeenCalledWith(
      'project-a',
      'destination-1',
      { eventType: 'digest.daily' },
    );
  });
});
