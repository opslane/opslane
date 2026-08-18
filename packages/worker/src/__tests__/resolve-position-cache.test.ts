import { beforeEach, describe, expect, it, vi } from 'vitest';

interface StoredPosition {
  original_file: string;
  original_function: string;
  original_line: number;
}

const positions = new Map<string, StoredPosition>();

const query = vi.fn(async (sql: string, params: unknown[]) => {
  const cacheKey = params.slice(0, 6).join(':');
  if (sql.includes('SELECT original_file')) {
    const row = positions.get(cacheKey);
    return { rows: row ? [row] : [] };
  }
  if (sql.includes('INSERT INTO sourcemap_position_cache')) {
    if (!positions.has(cacheKey)) {
      positions.set(cacheKey, {
        original_file: String(params[6]),
        original_function: String(params[7]),
        original_line: Number(params[8]),
      });
    }
    return { rows: [] };
  }
  throw new Error(`unexpected query: ${sql}`);
});

vi.mock('../db.js', () => ({
  getPool: () => ({ query }),
}));

const { lookupPosition, storePosition } = await import('../resolve/position-cache.js');

describe('position cache', () => {
  const key = {
    projectId: '00000000-0000-0000-0000-000000000001',
    debugId: 'c5cec566-6bbe-7c79-06b9-db1c71e746e5',
    mapContentSha: 'abc123',
    line: 17,
    column: 78242,
  };

  beforeEach(() => {
    positions.clear();
    query.mockClear();
  });

  it('returns null before anything is stored', async () => {
    expect(await lookupPosition(key)).toBeNull();
  });

  it('round-trips a stored position', async () => {
    await storePosition(key, {
      originalFile: 'src/AssetDetails.vue',
      originalFunction: 'deleteAsset',
      originalLine: 142,
    });

    expect(await lookupPosition(key)).toEqual({
      originalFile: 'src/AssetDetails.vue',
      originalFunction: 'deleteAsset',
      originalLine: 142,
    });
  });

  it('treats a different generated position as a different entry', async () => {
    await storePosition(key, {
      originalFile: 'src/Old.vue',
      originalFunction: 'old',
      originalLine: 1,
    });

    expect(await lookupPosition({ ...key, column: 99999 })).toBeNull();
  });
});
