import { describe, expect, it } from 'vitest';
import { formatRunLog } from '../run-logs/format.js';

describe('formatRunLog terminal safety', () => {
  it('shows control characters from stored text as escapes, keeping newlines and tabs', () => {
    const bundle = { phase: 'p', entryPoint: 'e', runId: 'r', workerBuildSha: 's', repository: null, settings: {}, request: 'first\u001b]52;c;aGk=\u0007', images: [] };
    const events = [{ type: 'tool_result', at: 't', id: 'u', name: 'read_file', output: 'ok\u001b[2Jcleared\tkept', isError: false }];
    const out = formatRunLog(bundle as never, events as never);
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(out).toContain('ok\\u001b[2Jcleared\tkept');
    expect(formatRunLog(bundle as never, null)).toContain('first\\u001b]52;c;aGk=\\u0007');
  });
});
