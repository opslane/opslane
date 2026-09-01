import { describe, expect, it } from 'vitest';
import { buildNarrativePrompt, NARRATIVE_PROMPT_VERSION } from '../prompt.js';

describe('narrative prompt v2', () => {
  it('is version 2', () => {
    expect(NARRATIVE_PROMPT_VERSION).toBe(2);
  });

  it('tells the model idle markers are absence, not latency', () => {
    const { system } = buildNarrativePrompt({ appContext: '', projectName: 'x', timelineText: '' });
    expect(system).toContain('[user idle ...]');
    expect(system).toContain('not as evidence of latency');
    expect(system).toContain('SLOW');
    expect(system).toContain('Never cite an idle marker line as slow_response');
  });
});
