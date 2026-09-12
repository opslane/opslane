// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import AgentPasteBox from '../AgentPasteBox.vue';

const stubs = { RouterLink: { template: '<a><slot /></a>' } };

describe('AgentPasteBox', () => {
  it('shows the one-line prompt with a copy button', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: write } });
    const w = mount(AgentPasteBox, { props: { variant: 'wizard' }, global: { stubs } });
    expect(w.text()).toContain('Paste into your agent');
    expect(w.find('[data-testid="agent-paste-line"]').text()).toBe('Set up https://docs.opslane.com/INSTALL.md');
    await w.find('button').trigger('click');
    expect(write).toHaveBeenCalledWith('Set up https://docs.opslane.com/INSTALL.md');
    expect(w.text()).toContain('The snippet is below');
  });
  it('empty variant links to the wizard instead of pointing at a snippet', () => {
    const w = mount(AgentPasteBox, { global: { stubs } });
    expect(w.text()).toContain('Setup guide');
    expect(w.text()).not.toContain('The snippet is below');
  });
});
