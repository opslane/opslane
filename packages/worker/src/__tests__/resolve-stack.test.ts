import { computeDebugId } from '@opslane/sdk/build/debug-id';
import { describe, expect, it } from 'vitest';
import {
  framesFromEnvelope,
  resolveEventStack,
  type ResolveDeps,
  type SourceMapRow,
} from '../resolve-stack.js';

const APP_FILE = 'http://app.example/assets/index-abc.js';
const VENDOR_FILE = 'http://app.example/assets/vendor-def.js';
const APP_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const VENDOR_ID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const STACK = `Error: boom
    at fn (${APP_FILE}:1:1)
    at ${VENDOR_FILE}:1:1`;
const MAP = JSON.stringify({
  version: 3,
  sources: ['src/App.vue'],
  sourcesContent: ['const value = missing.value;\n'],
  names: [],
  mappings: 'AAAA',
});

function meta(images: { code_file: string; debug_id: string }[]): string {
  return JSON.stringify({
    images: images.map((image) => ({ type: 'sourcemap', ...image })),
  });
}

async function deps(
  rows: SourceMapRow[],
  maps: Record<string, string | null>,
): Promise<ResolveDeps> {
  return {
    getMapRows: async () => rows,
    fetchMap: async (key) => maps[key] ?? null,
  };
}

async function row(debugID = APP_ID, objectKey = 'app.map', source = MAP): Promise<SourceMapRow> {
  const fingerprint = await computeDebugId(new TextEncoder().encode(source));
  return {
    debug_id: debugID,
    object_key: objectKey,
    content_sha256: fingerprint.contentSha256,
  };
}

describe('resolveEventStack', () => {
  it('returns no_debug_ids for empty images', async () => {
    const result = await resolveEventStack(
      { stackTraceRaw: STACK, debugMeta: '{"images":[]}', projectId: 'p' },
      await deps([], {}),
    );
    expect(result.status).toBe('no_debug_ids');
  });

  it('requires an exact code_file match and never falls back to basename', async () => {
    const result = await resolveEventStack(
      {
        stackTraceRaw: STACK,
        debugMeta: meta([{
          code_file: 'http://other.example/assets/index-abc.js',
          debug_id: APP_ID,
        }]),
        projectId: 'p',
      },
      await deps([], {}),
    );
    expect(result.status).toBe('no_debug_ids');
  });

  it('returns map_not_found when matched IDs have no rows', async () => {
    const result = await resolveEventStack(
      {
        stackTraceRaw: STACK,
        debugMeta: meta([{ code_file: APP_FILE, debug_id: APP_ID }]),
        projectId: 'p',
      },
      await deps([], {}),
    );
    expect(result.status).toBe('map_not_found');
  });

  it('returns invalid_map for malformed fetched bytes', async () => {
    const validRow = await row();
    const result = await resolveEventStack(
      {
        stackTraceRaw: STACK,
        debugMeta: meta([{ code_file: APP_FILE, debug_id: APP_ID }]),
        projectId: 'p',
      },
      await deps([validRow], { 'app.map': 'not json' }),
    );
    expect(result.status).toBe('invalid_map');
  });

  it('resolves a 1-based browser column and emits the pinned envelope', async () => {
    const validRow = await row();
    const result = await resolveEventStack(
      {
        stackTraceRaw: STACK,
        debugMeta: meta([{ code_file: APP_FILE, debug_id: APP_ID }]),
        projectId: 'p',
      },
      await deps([validRow], { 'app.map': MAP }),
    );
    expect(result.status).toBe('resolved');
    expect(result.frames?.[0]?.originalFile).toBe('src/App.vue');
    expect(result.envelope).toEqual({
      version: 1,
      frames: [expect.objectContaining({
        original_file: 'src/App.vue',
        original_line: 1,
        generated_column: 1,
        debug_id: APP_ID,
      })],
    });
  });

  it('returns partial when only one of two matched frames resolves', async () => {
    const appRow = await row();
    const result = await resolveEventStack(
      {
        stackTraceRaw: STACK,
        debugMeta: meta([
          { code_file: APP_FILE, debug_id: APP_ID },
          { code_file: VENDOR_FILE, debug_id: VENDOR_ID },
        ]),
        projectId: 'p',
      },
      await deps([appRow], { 'app.map': MAP }),
    );
    expect(result.status).toBe('partial');
    expect(result.frames).toHaveLength(1);
  });

  it('returns resolution_failed when storage throws', async () => {
    const validRow = await row();
    const result = await resolveEventStack(
      {
        stackTraceRaw: STACK,
        debugMeta: meta([{ code_file: APP_FILE, debug_id: APP_ID }]),
        projectId: 'p',
      },
      {
        getMapRows: async () => [validRow],
        fetchMap: async () => { throw new Error('storage offline'); },
      },
    );
    expect(result.status).toBe('resolution_failed');
  });

  it('keeps frames from reachable maps when one object fetch throws', async () => {
    const appRow = await row();
    const vendorRow = await row(VENDOR_ID, 'vendor.map');
    const result = await resolveEventStack(
      {
        stackTraceRaw: STACK,
        debugMeta: meta([
          { code_file: APP_FILE, debug_id: APP_ID },
          { code_file: VENDOR_FILE, debug_id: VENDOR_ID },
        ]),
        projectId: 'p',
      },
      {
        getMapRows: async () => [appRow, vendorRow],
        fetchMap: async (objectKey) => {
          if (objectKey === 'vendor.map') throw new Error('storage offline');
          return MAP;
        },
      },
    );
    expect(result.status).toBe('partial');
    expect(result.frames).toHaveLength(1);
    expect(result.envelope?.frames[0]?.debug_id).toBe(APP_ID);
  });

  it('rejects a fetched map whose canonical digest changed', async () => {
    const validRow = await row();
    const changed = JSON.stringify({
      version: 3,
      sources: ['src/Other.ts'],
      sourcesContent: ['other'],
      names: [],
      mappings: 'AAAA',
    });
    const result = await resolveEventStack(
      {
        stackTraceRaw: STACK,
        debugMeta: meta([{ code_file: APP_FILE, debug_id: APP_ID }]),
        projectId: 'p',
      },
      await deps([validRow], { 'app.map': changed }),
    );
    expect(result.status).toBe('invalid_map');
  });
});

describe('framesFromEnvelope', () => {
  it('converts a stored v1 envelope into the prompt frame shape', () => {
    expect(framesFromEnvelope({
      version: 1,
      frames: [{
        original_file: 'src/App.vue', original_line: 12, original_column: 4,
        source_snippet: 'const value = missing.value;',
        generated_file: APP_FILE, generated_line: 1, generated_column: 100,
        debug_id: APP_ID,
      }],
    })).toEqual([{
      originalFile: 'src/App.vue',
      originalLine: 12,
      originalColumn: 4,
      sourceSnippet: 'const value = missing.value;',
    }]);
  });

  it('round-trips a resolver envelope so both prompt paths agree', async () => {
    const result = await resolveEventStack(
      {
        stackTraceRaw: STACK,
        debugMeta: meta([{ code_file: APP_FILE, debug_id: APP_ID }]),
        projectId: 'p',
      },
      await deps([await row()], { 'app.map': MAP }),
    );
    expect(framesFromEnvelope(result.envelope)).toEqual(result.frames);
  });

  it('returns null for absent, malformed, or empty stored values', () => {
    expect(framesFromEnvelope(null)).toBeNull();
    expect(framesFromEnvelope({ version: 1, frames: [] })).toBeNull();
    expect(framesFromEnvelope({ version: 1, frames: [{ nope: 1 }] })).toBeNull();
    expect(framesFromEnvelope('not an envelope')).toBeNull();
  });
});
