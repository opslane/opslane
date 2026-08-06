import type { Adjudication, EvidenceStrength } from '@opslane/shared';
import { describe, expect, it } from 'vitest';
import { deriveOutcome } from '../classify.js';

const FRONTEND = { globs: ['client/**'] };
/** Identity resolver: every cited path resolves to itself. */
const resolvesToItself = (cited: string): string | null => cited;

function adjudication(overrides: Partial<Adjudication> = {}): Adjudication {
  return {
    best_supported: 'Null dereference rendering the asset list',
    why_chain: ['Render runs before fetch resolves', 'assets is null', 'map throws'],
    reproduction_steps: ['Open the panel on a slow connection'],
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
    expect(deriveOutcome(adjudication(), FRONTEND, resolvesToItself).outcome).toBe('code_fix');
  });

  it('routes a recognised external cause to not_actionable', () => {
    const result = deriveOutcome(
      adjudication({ cause_kind: 'external_system', cause_location: 'GET /issue-context/api/assets/search (remote service)' }),
      FRONTEND,
      resolvesToItself,
    );
    expect(result.outcome).toBe('not_actionable');
  });

  it('routes a real defect outside the surface to not_actionable', () => {
    const result = deriveOutcome(
      adjudication({ cause_location: 'server/app/routes/api/resources/asset.py:79' }),
      FRONTEND,
      resolvesToItself,
    );
    expect(result.outcome).toBe('not_actionable');
    expect(result.reason).toMatch(/outside the configured fix surface/);
  });

  it('routes a missing adjudication to needs_more_context', () => {
    expect(deriveOutcome(null, FRONTEND, resolvesToItself).outcome).toBe('needs_more_context');
  });

  it('routes an uncheckable citation to needs_more_context, never a conclusion', () => {
    const result = deriveOutcome(
      adjudication({ cause_location: 'client/asset-panel/src/Ghost.tsx:9' }),
      FRONTEND,
      () => null,
    );
    expect(result.outcome).toBe('needs_more_context');
    expect(result.reason).toMatch(/does not resolve/);
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
      resolvesToItself,
    );
    expect(result.outcome).toBe('needs_more_context');
  });
});

describe('evidence strength gates what the pipeline may do', () => {
  it('only conclusive evidence opens a pull request unattended', () => {
    const conclusive = deriveOutcome(adjudication({ evidence_strength: 'conclusive' }), FRONTEND, resolvesToItself);
    const suggestive = deriveOutcome(adjudication({ evidence_strength: 'suggestive' }), FRONTEND, resolvesToItself);
    expect(conclusive.confidence).toBe('high');
    expect(suggestive.confidence).toBe('medium');
    expect(suggestive.outcome).toBe('code_fix');
  });

  it('insufficient evidence fails even when the location looks perfect', () => {
    const result = deriveOutcome(adjudication({ evidence_strength: 'insufficient' }), FRONTEND, resolvesToItself);
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
    expect(deriveOutcome(padded, FRONTEND, resolvesToItself).confidence).toBe('medium');
  });

  it.each<[EvidenceStrength, string]>([
    ['conclusive', 'high'],
    ['suggestive', 'medium'],
  ])('carries %s through to an external conclusion as %s confidence', (strength, expected) => {
    const result = deriveOutcome(
      adjudication({ evidence_strength: strength, cause_kind: 'external_system', cause_location: 'https://cdn.example.com/app.js' }),
      FRONTEND,
      resolvesToItself,
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
    expect(deriveOutcome(b, FRONTEND, resolvesToItself).outcome)
      .toBe(deriveOutcome(a, FRONTEND, resolvesToItself).outcome);
  });

  it('moving the defect does change where it lands', () => {
    const inside = adjudication({ cause_location: 'client/asset-panel/src/AssetList.tsx:42' });
    const outside = adjudication({ cause_location: 'server/app/routes/api/resources/asset.py:79' });
    expect(deriveOutcome(inside, FRONTEND, resolvesToItself).outcome)
      .not.toBe(deriveOutcome(outside, FRONTEND, resolvesToItself).outcome);
  });

  it('an unconfigured surface keeps the pre-existing whole-repository behaviour', () => {
    const result = deriveOutcome(
      adjudication({ cause_location: 'server/app/routes/api/resources/asset.py:79' }),
      { globs: null },
      resolvesToItself,
    );
    expect(result.outcome).toBe('code_fix');
  });
});

describe('the cause kind is read as a typed value, not matched from prose', () => {
  const base = {
    best_supported: 'An upstream gateway rate-limited the client',
    why_chain: ['Client calls the endpoint', 'The gateway returns 429'],
    reproduction_steps: ['Call the endpoint repeatedly'],
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
      resolvesToItself,
    );
    expect(result.outcome).toBe('not_actionable');
  });

  it('reaches a conclusion for a data cause with no location at all', () => {
    const result = deriveOutcome(
      { ...base, cause_kind: 'data_or_input', cause_location: '' },
      FRONTEND,
      resolvesToItself,
    );
    expect(result.outcome).toBe('not_actionable');
  });

  it('fails when the kind is unknown however confident the prose sounds', () => {
    const result = deriveOutcome(
      { ...base, cause_kind: 'unknown', cause_location: 'client/asset-panel/src/AssetList.tsx:42' },
      FRONTEND,
      resolvesToItself,
    );
    expect(result.outcome).toBe('needs_more_context');
  });

  it('still requires a resolvable file when the kind claims local code', () => {
    const result = deriveOutcome(
      { ...base, cause_kind: 'local_code', cause_location: 'the fetcher module' },
      FRONTEND,
      resolvesToItself,
    );
    expect(result.outcome).toBe('needs_more_context');
  });
});

describe('the fix surface is checked against the resolved path', () => {
  const cited = 'client/vendor/app/asset.py';
  const resolvesThroughSymlink = (path: string): string | null =>
    path === cited ? 'server/app/asset.py' : path;

  // The composition bug: resolveInsideRepo existed and was called, but only for
  // its truthiness, and the glob was then matched against the string the model
  // supplied. Each function was tested alone and both passed while a symlink
  // inside the surface still authorised a write outside it.
  it('refuses a citation that resolves outside the surface through a symlink', () => {
    const result = deriveOutcome(
      adjudication({ cause_kind: 'local_code', cause_location: `${cited}:1` }),
      FRONTEND,
      resolvesThroughSymlink,
    );
    expect(result.outcome).toBe('not_actionable');
    expect(result.reason).toContain('resolves to server/app/asset.py');
  });

  it('reports the resolved path, not the cited one, when it does authorise a fix', () => {
    const result = deriveOutcome(
      adjudication({ cause_location: 'client/link.tsx:3' }),
      FRONTEND,
      () => 'client/real/Component.tsx',
    );
    expect(result.outcome).toBe('code_fix');
    expect(result.reason).toContain('client/real/Component.tsx');
  });
});

describe('an external conclusion has to be reached against the local candidates', () => {
  const external = adjudication({
    cause_kind: 'external_system',
    cause_location: 'upstream gateway',
    rejected: [],
  });

  it('refuses to conclude external while leaving a local candidate unaddressed', () => {
    const result = deriveOutcome(external, FRONTEND, resolvesToItself, 2);
    expect(result.outcome).toBe('needs_more_context');
    expect(result.reason).toMatch(/without rejecting 2 local candidate/);
  });

  it('accepts the conclusion once those candidates are rejected', () => {
    const result = deriveOutcome(
      { ...external, rejected: ['QueryClient retry: the requests are 11 minutes apart'] },
      FRONTEND,
      resolvesToItself,
      2,
    );
    expect(result.outcome).toBe('not_actionable');
  });

  it('does not demand rejections the dossier never raised', () => {
    const result = deriveOutcome(external, FRONTEND, resolvesToItself, 0);
    expect(result.outcome).toBe('not_actionable');
  });
});
