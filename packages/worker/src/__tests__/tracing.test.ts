import { describe, it, expect, beforeEach } from 'vitest';
import { traceSpan, withJobTrace, initTracing, shutdownTracing, getToolSpanAttributes } from '../tracing.js';

// All tests run WITHOUT Langfuse env vars, so tracing is disabled (no-op mode).
// This validates graceful degradation.

describe('tracing', () => {
  beforeEach(() => {
    delete process.env['LANGFUSE_PUBLIC_KEY'];
    delete process.env['LANGFUSE_SECRET_KEY'];
    delete process.env['LANGFUSE_BASE_URL'];
    delete process.env['LANGFUSE_PROJECT_ID'];
  });

  describe('traceSpan', () => {
    it('passes through when tracing is not initialized', async () => {
      const result = await traceSpan('test-span', { key: 'value' }, async () => {
        return 42;
      });
      expect(result).toBe(42);
    });

    it('re-throws errors from wrapped function', async () => {
      await expect(
        traceSpan('test-span', {}, async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
    });

    it('preserves return type', async () => {
      const result = await traceSpan('test', {}, async () => ({ a: 1, b: 'two' }));
      expect(result).toEqual({ a: 1, b: 'two' });
    });
  });

  describe('withJobTrace', () => {
    it('passes through when tracing is not initialized', async () => {
      const result = await withJobTrace('job-1', 'eg-1', 'proj-1', async () => {
        return 'done';
      });
      expect(result).toBe('done');
    });

    it('re-throws errors from wrapped function', async () => {
      await expect(
        withJobTrace('job-1', 'eg-1', 'proj-1', async () => {
          throw new Error('job failed');
        }),
      ).rejects.toThrow('job failed');
    });
  });

  describe('initTracing', () => {
    it('is a no-op when no Langfuse env is set', async () => {
      await expect(initTracing()).resolves.toBeUndefined();
    });
  });

  describe('shutdownTracing', () => {
    it('resolves immediately when tracing is not initialized', async () => {
      await shutdownTracing();
    });
  });

  describe('getToolSpanAttributes', () => {
    it('extracts file path for read tool', () => {
      const attrs = getToolSpanAttributes('read', { path: '/home/user/repo/src/App.vue' }, 'file content here', false);
      expect(attrs['tool.name']).toBe('read');
      expect(attrs['tool.file_path']).toBe('/home/user/repo/src/App.vue');
      expect(attrs['tool.output_length']).toBe(17);
      expect(attrs['tool.is_error']).toBe(false);
      expect(Object.values(attrs)).not.toContain('file content here');
    });

    it('extracts file path for write tool', () => {
      const attrs = getToolSpanAttributes('write', { path: '/home/user/repo/src/index.ts', content: 'secret code' }, 'Written', false);
      expect(attrs['tool.file_path']).toBe('/home/user/repo/src/index.ts');
      expect(Object.values(attrs)).not.toContain('secret code');
    });

    it('extracts file path for edit tool', () => {
      const attrs = getToolSpanAttributes('edit', { path: '/home/user/repo/src/App.vue', old_string: 'old', new_string: 'new' }, 'Applied', false);
      expect(attrs['tool.file_path']).toBe('/home/user/repo/src/App.vue');
      expect(Object.values(attrs)).not.toContain('old');
      expect(Object.values(attrs)).not.toContain('new');
    });

    it('extracts command for bash tool (truncated to 200 chars)', () => {
      const longCmd = 'npm test -- --reporter=verbose ' + 'x'.repeat(300);
      const attrs = getToolSpanAttributes('bash', { command: longCmd }, 'test output', false);
      expect(attrs['tool.name']).toBe('bash');
      expect((attrs['tool.command'] as string).length).toBeLessThanOrEqual(200);
      expect(attrs['tool.output_length']).toBe(11);
      expect(Object.values(attrs)).not.toContain('test output');
    });

    it('extracts pattern for search tool', () => {
      const attrs = getToolSpanAttributes('search', { pattern: 'handleClick', path: '/home/user/repo' }, 'matches', false);
      expect(attrs['tool.name']).toBe('search');
      expect(attrs['tool.pattern']).toBe('handleClick');
      expect(attrs['tool.search_path']).toBe('/home/user/repo');
    });

    it('extracts paths for read_many tool', () => {
      const attrs = getToolSpanAttributes('read_many', { paths: ['a.ts', 'b.ts'] }, '{}', false);
      expect(attrs['tool.paths']).toBe('a.ts, b.ts');
    });

    it('extracts cause location for submit_diagnosis tool', () => {
      const attrs = getToolSpanAttributes('submit_diagnosis', { cause_location: 'src/App.vue:42' }, 'Acknowledged', false);
      expect(attrs['tool.name']).toBe('submit_diagnosis');
      expect(attrs['tool.cause_location']).toBe('src/App.vue:42');
    });

    it('only logs output_length for patch tool', () => {
      const attrs = getToolSpanAttributes('patch', { diff: 'secret diff content' }, 'Patch applied', false);
      expect(attrs['tool.name']).toBe('patch');
      expect(attrs['tool.output_length']).toBe(13);
      expect(Object.values(attrs)).not.toContain('secret diff content');
    });

    it('marks errors', () => {
      const attrs = getToolSpanAttributes('bash', { command: 'npm test' }, 'Error: failed', true);
      expect(attrs['tool.is_error']).toBe(true);
    });
  });
});
