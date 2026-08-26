// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ getOnboardingState: vi.fn() }));
vi.mock('../../api', () => api);

import OnboardingBanners from '../OnboardingBanners.vue';

const state = (githubConnected: boolean, slackConnected: boolean) => ({
  onboarding_complete: true,
  next_step: 'done',
  project_id: 'p1',
  has_events: true,
  github_connected: githubConnected,
  github_mode: 'app',
  slack_connected: slackConnected,
});

function mountBanners() {
  return mount(OnboardingBanners, {
    global: {
      stubs: {
        RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
      },
    },
  });
}

describe('OnboardingBanners', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows missing GitHub and Slack integrations with Settings links', async () => {
    api.getOnboardingState.mockResolvedValue(state(false, false));
    const wrapper = mountBanners();
    await flushPromises();

    expect(wrapper.text()).toContain('Connect GitHub to get automated fix PRs');
    expect(wrapper.text()).toContain('Connect Slack to get your daily digest');
    expect(wrapper.findAll('a').map((link) => link.attributes('href'))).toEqual(['/settings', '/settings']);
    wrapper.unmount();
  });

  it('renders nothing when both integrations are connected', async () => {
    api.getOnboardingState.mockResolvedValue(state(true, true));
    const wrapper = mountBanners();
    await flushPromises();

    expect(wrapper.text()).toBe('');
    wrapper.unmount();
  });

  it('keeps the last good banner state when refresh fails', async () => {
    api.getOnboardingState.mockResolvedValueOnce(state(false, true));
    const wrapper = mountBanners();
    await flushPromises();
    expect(wrapper.text()).toContain('Connect GitHub');

    api.getOnboardingState.mockRejectedValue(new Error('offline'));
    window.dispatchEvent(new Event('opslane-integrations-changed'));
    await flushPromises();

    expect(wrapper.text()).toContain('Connect GitHub');
    expect(wrapper.text()).not.toContain('Connect Slack');
    wrapper.unmount();
  });
});
