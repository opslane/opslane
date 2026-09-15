// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import AgentPasteBox from '../AgentPasteBox.vue';

describe('AgentPasteBox', () => {
  it('shows the one-line prompt with a copy button and no manual-setup link', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: write } });
    const w = mount(AgentPasteBox);
    expect(w.text()).toContain('Paste into your agent');
    expect(w.find('[data-testid="agent-paste-line"]').text()).toBe('Set up https://docs.opslane.com/INSTALL.md');
    await w.find('button').trigger('click');
    expect(write).toHaveBeenCalledWith('Set up https://docs.opslane.com/INSTALL.md');
    expect(w.find('a').exists()).toBe(false);
    expect(w.text()).not.toMatch(/Setup guide|snippet/i);
  });
});
