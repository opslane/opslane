import { describe, expect, it } from 'vitest';
import { parseTranscriptEvent } from '../schema.js';

const event = (output: string) => ({ type: 'tool_result', at: '2026-09-15T00:00:00.000Z', id: 'u', name: 'read_file', output, isError: false });

describe('image byte rejection', () => {
  it('accepts text that only mentions a data URL prefix, or a payload already replaced', () => {
    expect(() => parseTranscriptEvent(event('const imagePrefix = "data:image/";'))).not.toThrow();
    expect(() => parseTranscriptEvent(event('<img src="data:image/png;base64,[image]">'))).not.toThrow();
  });

  it('rejects an inline base64 image payload', () => {
    expect(() => parseTranscriptEvent(event('<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUg">'))).toThrow(/image bytes/);
  });
});
