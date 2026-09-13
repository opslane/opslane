import { describe, expect, it } from 'vitest';
import { embeddingsRequired } from '../match-job.js';

describe('embeddingsRequired', () => {
  it('is true only for a payload that asks for embeddings', () => {
    expect(embeddingsRequired({ backfill: true, requireEmbeddings: true })).toBe(true);
    expect(embeddingsRequired({ backfill: true })).toBe(false);
    expect(embeddingsRequired({ requireEmbeddings: 'yes' })).toBe(false);
    expect(embeddingsRequired(null)).toBe(false);
    expect(embeddingsRequired(undefined)).toBe(false);
  });
});
