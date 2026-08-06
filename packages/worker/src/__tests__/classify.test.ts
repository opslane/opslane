import type { Adjudication, EvidenceStrength } from '@opslane/shared';
import { describe, expect, it } from 'vitest';
import { deriveOutcome } from '../classify.js';

const FRONTEND = { globs: ['client/**'] };
const allFilesExist = (): boolean => true;

function adjudication(overrides: Partial<Adjudication> = {}): Adjudication {
  return {
    best_supported: 'Null dereference rendering the asset list',
    why_chain: ['Render runs before fetch resolves', 'assets is null', 'map throws'],
    evidence_check: 'Opened AssetList.tsx:42 and confirmed the unguarded map call.',
    rejected: ['Slow endpoint: the breadcrumb shows a 200 in 40ms'],
    evidence_strength: 'conclusive',
    cause_kind: 'local_code',
    cause_location: 'client/asset-panel/src/AssetList.tsx:42',
    reasoning: 'The cited line dereferences assets without a null guard.',
    ...overrides,
  };
}

describe('deriveOutcome routing', () => {
  it('routes a verified defect inside the surface to code_fix', () => {
    expect(deriveOutcome(adjudication(), FRONTEND, allFilesExist).outcome).toBe('code_fix');
  });

  it('routes a recognised external cause to not_actionable', () => {
    const result = deriveOutcome(
      adjudication({ cause_kind: 'external_system', cause_location: 'GET /issue-context/api/assets/search (remote service)' }),
      FRONTEND,
      allFilesExist,
    );
    expect(result.outcome).toBe('not_actionable');
  });

  it('routes a real defect outside the surface to not_actionable', () => {
    const result = deriveOutcome(
      adjudication({ cause_location: 'server/app/routes/api/resources/asset.py:79' }),
      FRONTEND,
      allFilesExist,
    );
    expect(result.outcome).toBe('not_actionable');
    expect(result.reason).toMatch(/outside the configured fix surface/);
  });

  it('routes a missing adjudication to needs_more_context', () => {
    expect(deriveOutcome(null, FRONTEND, allFilesExist).outcome).toBe('needs_more_context');
  });

  it('routes an uncheckable citation to needs_more_context, never a conclusion', () => {
    const result = deriveOutcome(
      adjudication({ cause_location: 'client/asset-panel/src/Ghost.tsx:9' }),
      FRONTEND,
      () => false,
    );
    expect(result.outcome).toBe('needs_more_context');
    expect(result.reason).toMatch(/does not exist/);
  });

  it.each([
    'unknown',
    'probably the backend',
    'could not locate the cause',
    'somewhere in the API layer',
    'client/asset-panel/src',
  ])('routes an unciteable local claim %j to needs_more_context', (location) => {
    const result = deriveOutcome(
      adjudication({ cause_kind: 'local_code', cause_location: location }),
      FRONTEND,
      allFilesExist,
    );
    expect(result.outcome).toBe('needs_more_context');
  });
});

describe('evidence strength gates what the pipeline may do', () => {
  it('only conclusive evidence opens a pull request unattended', () => {
    const conclusive = deriveOutcome(adjudication({ evidence_strength: 'conclusive' }), FRONTEND, allFilesExist);
    const suggestive = deriveOutcome(adjudication({ evidence_strength: 'suggestive' }), FRONTEND, allFilesExist);
    expect(conclusive.confidence).toBe('high');
    expect(suggestive.confidence).toBe('medium');
    expect(suggestive.outcome).toBe('code_fix');
  });

  it('insufficient evidence fails even when the location looks perfect', () => {
    const result = deriveOutcome(adjudication({ evidence_strength: 'insufficient' }), FRONTEND, allFilesExist);
    expect(result.outcome).toBe('needs_more_context');
    expect(result.confidence).toBe('low');
  });

  // Confidence used to be counted from field lengths, so three repeated
  // sentences plus any line number scored high and opened a PR unattended.
  it('cannot be reached by padding the fields', () => {
    const padded = adjudication({
      evidence_strength: 'suggestive',
      why_chain: ['it broke', 'it broke', 'it broke', 'it broke', 'it broke'],
    });
    expect(deriveOutcome(padded, FRONTEND, allFilesExist).confidence).toBe('medium');
  });

  it.each<[EvidenceStrength, string]>([
    ['conclusive', 'high'],
    ['suggestive', 'medium'],
  ])('carries %s through to an external conclusion as %s confidence', (strength, expected) => {
    const result = deriveOutcome(
      adjudication({ evidence_strength: strength, cause_kind: 'external_system', cause_location: 'https://cdn.example.com/app.js' }),
      FRONTEND,
      allFilesExist,
    );
    expect(result.outcome).toBe('not_actionable');
    expect(result.confidence).toBe(expected);
  });
});

describe('routing invariants', () => {
  it('rewording an adjudication does not change where it lands', () => {
    const a = adjudication();
    const b = adjudication({
      best_supported: 'The asset list blows up on a null collection',
      why_chain: ['Render happens first', 'The collection is null', 'Calling map on null throws'],
      reasoning: 'Same defect, different words.',
    });
    expect(deriveOutcome(b, FRONTEND, allFilesExist).outcome)
      .toBe(deriveOutcome(a, FRONTEND, allFilesExist).outcome);
  });

  it('moving the defect does change where it lands', () => {
    const inside = adjudication({ cause_location: 'client/asset-panel/src/AssetList.tsx:42' });
    const outside = adjudication({ cause_location: 'server/app/routes/api/resources/asset.py:79' });
    expect(deriveOutcome(inside, FRONTEND, allFilesExist).outcome)
      .not.toBe(deriveOutcome(outside, FRONTEND, allFilesExist).outcome);
  });

  it('an unconfigured surface keeps the pre-existing whole-repository behaviour', () => {
    const result = deriveOutcome(
      adjudication({ cause_location: 'server/app/routes/api/resources/asset.py:79' }),
      { globs: null },
      allFilesExist,
    );
    expect(result.outcome).toBe('code_fix');
  });
});

describe('the cause kind is read as a typed value, not matched from prose', () => {
  const base = {
    best_supported: 'An upstream gateway rate-limited the client',
    why_chain: ['Client calls the endpoint', 'The gateway returns 429'],
    evidence_check: 'No rate-limit configuration exists anywhere in the repository.',
    rejected: ['Client retry loop: the requests are minutes apart'],
    evidence_strength: 'suggestive' as const,
    reasoning: 'The 429 is server-issued and no repository code produces it.',
  };

  // The exact string a live run produced. It contains no URL, no HTTP method
  // and no hostname, so prose matching called it vague and lost the answer.
  it('reaches a conclusion for an external cause described in plain words', () => {
    const result = deriveOutcome(
      { ...base, cause_kind: 'external_system', cause_location: 'upstream API gateway / reverse proxy (not present in repository)' },
      FRONTEND,
      allFilesExist,
    );
    expect(result.outcome).toBe('not_actionable');
  });

  it('reaches a conclusion for a data cause with no location at all', () => {
    const result = deriveOutcome(
      { ...base, cause_kind: 'data_or_input', cause_location: '' },
      FRONTEND,
      allFilesExist,
    );
    expect(result.outcome).toBe('not_actionable');
  });

  it('fails when the kind is unknown however confident the prose sounds', () => {
    const result = deriveOutcome(
      { ...base, cause_kind: 'unknown', cause_location: 'client/asset-panel/src/AssetList.tsx:42' },
      FRONTEND,
      allFilesExist,
    );
    expect(result.outcome).toBe('needs_more_context');
  });

  it('still requires a resolvable file when the kind claims local code', () => {
    const result = deriveOutcome(
      { ...base, cause_kind: 'local_code', cause_location: 'the fetcher module' },
      FRONTEND,
      allFilesExist,
    );
    expect(result.outcome).toBe('needs_more_context');
  });
});
