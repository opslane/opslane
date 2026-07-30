// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeDebugId, DebugIdError } from '../build/debug-id.js';
import type { DebugIdRejectReason } from '../build/debug-id.js';

interface DebugIdVector {
  name: string;
  input_b64: string;
  outcome: 'ok' | 'reject';
  sha256?: string;
  debug_id?: string;
  reject_reason?: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(
  readFileSync(
    join(here, '../../../../test-fixtures/debug-id/vectors.json'),
    'utf8',
  ),
) as { cases: DebugIdVector[] };

describe('computeDebugId', () => {
  for (const vector of vectors.cases.filter((entry) => entry.outcome === 'ok')) {
    it(`${vector.name}: matches the frozen fingerprint`, async () => {
      const bytes = Buffer.from(vector.input_b64, 'base64');
      const result = await computeDebugId(new Uint8Array(bytes));

      expect(result.contentSha256).toBe(vector.sha256);
      expect(result.debugId).toBe(vector.debug_id);
    });
  }

  for (const vector of vectors.cases.filter(
    (entry) => entry.outcome === 'reject',
  )) {
    it(`${vector.name}: rejects with ${vector.reject_reason}`, async () => {
      const bytes = Buffer.from(vector.input_b64, 'base64');

      await expect(computeDebugId(new Uint8Array(bytes))).rejects.toEqual(
        expect.objectContaining<Partial<DebugIdError>>({
          reason: vector.reject_reason as DebugIdRejectReason,
        }),
      );
    });
  }
});
