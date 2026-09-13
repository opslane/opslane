import { describe, expect, it } from 'vitest';
import { buildNarrativePrompt, NARRATIVE_PROMPT_VERSION } from '../prompt.js';

describe('narrative prompt v3', () => {
  it('is version 3', () => {
    expect(NARRATIVE_PROMPT_VERSION).toBe(3);
  });

  it('asks for observable descriptions and evidence without classifications', () => {
    const { system } = buildNarrativePrompt({ appContext: '', projectName: 'x', timelineText: '' });
    expect(system).toContain('kinds of difficulty to look for');
    expect(system).toContain('what the screen showed');
    expect(system).toContain('consecutive lines');
    expect(system).not.toContain('"category":');
    expect(system).not.toContain('"severity":');
  });

  it('tells the model idle markers are absence, not latency', () => {
    const { system } = buildNarrativePrompt({ appContext: '', projectName: 'x', timelineText: '' });
    expect(system).toContain('[user idle ...]');
    expect(system).toContain('not as evidence of latency');
    expect(system).toContain('SLOW');
    expect(system).toContain('Never cite an idle marker line as slow_response');
  });
});
