import { afterEach, describe, expect, it, vi } from 'vitest';
import { insightInvestigateUsers, investigationAllowed } from '../tickets-db.js';

describe('insightInvestigateUsers', () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each([
    ['unset', undefined, 5],
    ['custom', '8', 8],
    ['zero', '0', 5],
    ['negative', '-3', 5],
    ['fractional', '2.5', 5],
    ['garbage', 'five', 5],
  ])('%s → %s', (_name, value, expected) => {
    if (value === undefined) vi.stubEnv('FRICTION_INSIGHT_INVESTIGATE_USERS', '');
    else vi.stubEnv('FRICTION_INSIGHT_INVESTIGATE_USERS', value);
    expect(insightInvestigateUsers()).toBe(expected);
  });
  it('gates insights only', () => {
    vi.stubEnv('FRICTION_INSIGHT_INVESTIGATE_USERS', '5');
    expect(investigationAllowed({ kind: 'defect' }, 0)).toBe(true);
    expect(investigationAllowed({ kind: 'ux_insight' }, 4)).toBe(false);
    expect(investigationAllowed({ kind: 'ux_insight' }, 5)).toBe(true);
  });
});

describe('publishedNeighbors query planning', () => {
  it('passes non-generic quoted strings to SQL search even with no embedding', async () => {
    const { publishedNeighbors } = await import('../tickets-db.js');
    const mockDb = {
      query: vi.fn(),
    };
    // Mock confirmed evidence query
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          { text: 'User saw "Fill in the required fields to continue: Name, Asset Type" on save' },
        ],
      })
      .mockResolvedValueOnce({
        rows: [],
      });

    const ticket = {
      id: 'ticket-1',
      project_id: 'proj-1',
      environment_id: 'env-1',
      name: 'Save error',
      control: 'Save',
      what_happened: 'Validation failed',
      embedding: null,
      embedding_model: null,
    } as any;

    await publishedNeighbors(mockDb as any, ticket);

    expect(mockDb.query).toHaveBeenCalledTimes(2);
    const sqlParams = mockDb.query.mock.calls[1][1];
    // Quote pattern must be passed as $7
    expect(sqlParams[6]).toEqual([
      '%fill in the required fields to continue: name, asset type%',
    ]);
  });

  it('does not pass quote pattern when only generic quoted strings are present', async () => {
    const { publishedNeighbors } = await import('../tickets-db.js');
    const mockDb = {
      query: vi.fn(),
    };
    mockDb.query.mockResolvedValueOnce({
      rows: [{ text: 'Spinner still says "Loading"' }],
    });

    const ticket = {
      id: 'ticket-1',
      project_id: 'proj-1',
      environment_id: 'env-1',
      name: 'Slow save',
      control: 'Save',
      what_happened: 'Save takes time',
      embedding: null,
      embedding_model: null,
    } as any;

    const result = await publishedNeighbors(mockDb as any, ticket);

    // With no embedding and only generic quotes, it returns [] without running second query
    expect(mockDb.query).toHaveBeenCalledTimes(1);
    expect(result).toEqual([]);
  });
});
