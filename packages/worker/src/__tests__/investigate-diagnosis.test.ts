import { describe, expect, it } from 'vitest';
import { buildDiagnosis } from '../investigate.js';

const adjudication = {
  best_supported: 'The backend swallows the exception',
  why_chain: ['bare except'],
  reproduction_steps: ['delete 100 assets'],
  cause_locations: [
    { path: 'server/app/routes/api/resources/asset.py' },
    { path: 'vue3/client/src/modules/common/fetch/fetcher.ts' },
  ],
  evidence: [],
  agent_task_brief: 'brief',
};

describe('buildDiagnosis', () => {
  it('keeps cause locations as a list in the order the model ranked them', () => {
    expect(buildDiagnosis(adjudication)?.cause_locations).toEqual([
      'server/app/routes/api/resources/asset.py',
      'vue3/client/src/modules/common/fetch/fetcher.ts',
    ]);
  });

  it('still writes the joined string existing readers depend on', () => {
    expect(buildDiagnosis(adjudication)?.cause_location).toBe(
      'server/app/routes/api/resources/asset.py, vue3/client/src/modules/common/fetch/fetcher.ts',
    );
  });

  it('survives the JSON round trip the decision writer performs', () => {
    const stored = JSON.parse(JSON.stringify(buildDiagnosis(adjudication)));
    expect(stored.cause_locations).toHaveLength(2);
    expect(stored.cause_locations[0]).toBe('server/app/routes/api/resources/asset.py');
  });

  it('returns null when there is no adjudication', () => {
    expect(buildDiagnosis(null)).toBeNull();
  });
});
