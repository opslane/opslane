import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { EvidenceBundle } from '../evidence/bundle.js';

interface EvaluationFixture {
  version: number;
  cases: Array<{
    name: string;
    issueType: string;
    expected: 'investigate' | 'wait_for_more_evidence' | 'do_not_pursue';
    evidence: EvidenceBundle;
  }>;
}

describe('inquiry production evaluation fixture', () => {
  it('freezes all six named production cases as bounded evidence bundles', async () => {
    const raw = await readFile(
      new URL('../inquiry/__fixtures__/production-set.json', import.meta.url),
      'utf8',
    );
    const fixture = JSON.parse(raw) as EvaluationFixture;

    expect(fixture.version).toBe(1);
    expect(fixture.cases.map((entry) => entry.name)).toEqual([
      'asset-deletion-cluster',
      'assets-dead-click-cards',
      'stale-release-assets',
      'browser-extension-noise',
      'one-user-errors',
      'previous-needs-more-context',
    ]);
    for (const entry of fixture.cases) {
      expect(entry.issueType).not.toBe('');
      expect(entry.evidence.affectedUnits).toBeGreaterThan(0);
      expect(entry.evidence.frames.sourceEventId).not.toBe('');
      expect(entry.evidence.relatedCandidates.length).toBeLessThanOrEqual(10);
    }
  });
});
