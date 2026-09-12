// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => {
  class APIError extends Error {
    constructor(
      public readonly status: number,
      message: string,
      public readonly code?: string,
      public readonly details: Record<string, string> = {},
    ) {
      super(message);
    }
  }
  return { agentGitHubInstallUrl: vi.fn(), APIError };
});
vi.mock('../../api', () => api);
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { id: 'session-1' } }) }));

import AgentGitHubInstall from '../AgentGitHubInstall.vue';

describe('AgentGitHubInstall', () => {
  beforeEach(() => vi.resetAllMocks());

  it('requests the session install URL and redirects to GitHub', async () => {
    api.agentGitHubInstallUrl.mockResolvedValue({ install_url: 'https://github.com/apps/opslane/installations/new?state=abc' });
    const navigate = vi.fn();
    mount(AgentGitHubInstall, { props: { navigate } });
    await flushPromises();
    expect(api.agentGitHubInstallUrl).toHaveBeenCalledWith('session-1');
    expect(navigate).toHaveBeenCalledWith('https://github.com/apps/opslane/installations/new?state=abc');
  });

  it('shows the current page URL when an organization admin is required', async () => {
    api.agentGitHubInstallUrl.mockRejectedValue(new api.APIError(403, 'organization admin required'));
    const wrapper = mount(AgentGitHubInstall);
    await flushPromises();
    expect(wrapper.text()).toContain('organization admin');
    expect(wrapper.get('[data-testid="agent-github-install-link"]').text()).toBe(window.location.href);
  });

  it('does not show an admin handoff for a foreign organization', async () => {
    api.agentGitHubInstallUrl.mockRejectedValue(new api.APIError(403, 'another organization', 'foreign_org'));
    const wrapper = mount(AgentGitHubInstall);
    await flushPromises();
    expect(wrapper.text()).toContain('another organization');
    expect(wrapper.find('[data-testid="agent-github-install-link"]').exists()).toBe(false);
  });
});
