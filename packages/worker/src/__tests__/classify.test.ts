import type { Adjudication, EvidenceStrength } from '@opslane/shared';
import { describe, expect, it } from 'vitest';
import { deriveOutcome } from '../classify.js';

const FRONTEND = { globs: ['client/**'] };
/** The escape hatch is on in these tests unless a case is specifically about it. */
const POLICY = { allowUnrestrictedSurface: true };
/** Identity resolver: every cited path resolves to itself. */
const resolvesToItself = (cited: string): string | null => cited;

function adjudication(overrides: Partial<Adjudication> = {}): Adjudication {
  return {
    best_supported: 'Null dereference rendering the asset list',
    why_chain: ['Render runs before fetch resolves', 'assets is null', 'map throws'],
    reproduction_steps: ['Open the panel on a slow connection'],
    evidence_check: 'Opened AssetList.tsx:42 and confirmed the unguarded map call.',
    candidates_considered: [{ statement: 'Null dereference rendering the asset list', kind: 'local_code' }],
    rejected: [
      'Slow endpoint: the breadcrumb shows a 200 in 40ms',
      'Null dereference rendering the asset list: ruled out where the conclusion is external',
    ],
    evidence_strength: 'conclusive',
    cause_kind: 'local_code',
    cause_locations: ['client/asset-panel/src/AssetList.tsx:42'],
    reasoning: 'The cited line dereferences assets without a null guard.',
    ...overrides,
  };
}

describe('deriveOutcome routing', () => {
  it('routes a verified defect inside the surface to code_fix', () => {
    expect(deriveOutcome(adjudication(), FRONTEND, resolvesToItself, POLICY).outcome).toBe('code_fix');
  });

  it('routes a recognised external cause to not_actionable', () => {
    const result = deriveOutcome(
      adjudication({ cause_kind: 'external_system', cause_locations: ['GET /issue-context/api/assets/search (remote service)'] }),
      FRONTEND,
      resolvesToItself,
      POLICY,
    );
    expect(result.outcome).toBe('not_actionable');
  });

  it('routes a real defect outside the surface to not_actionable', () => {
    const result = deriveOutcome(
      adjudication({ cause_locations: ['server/app/routes/api/resources/asset.py:79'] }),
      FRONTEND,
      resolvesToItself,
      POLICY,
    );
    expect(result.outcome).toBe('not_actionable');
    expect(result.reason).toMatch(/outside the configured fix surface/);
  });

  it('routes a missing adjudication to needs_more_context', () => {
    expect(deriveOutcome(null, FRONTEND, resolvesToItself, POLICY).outcome).toBe('needs_more_context');
  });

  it('routes an uncheckable citation to needs_more_context, never a conclusion', () => {
    const result = deriveOutcome(
      adjudication({ cause_locations: ['client/asset-panel/src/Ghost.tsx:9'] }),
      FRONTEND,
      () => null,
      POLICY,
    );
    expect(result.outcome).toBe('needs_more_context');
    expect(result.reason).toMatch(/does not resolve to a file/);
  });

  it.each([
    'unknown',
    'probably the backend',
    'could not locate the cause',
    'somewhere in the API layer',
    'client/asset-panel/src',
  ])('routes an unciteable local claim %j to needs_more_context', (location) => {
    const result = deriveOutcome(
      adjudication({ cause_kind: 'local_code', cause_locations: [location] }),
      FRONTEND,
      resolvesToItself,
      POLICY,
    );
    expect(result.outcome).toBe('needs_more_context');
  });
});

describe('evidence strength gates what the pipeline may do', () => {
  it('only conclusive evidence opens a pull request unattended', () => {
    const conclusive = deriveOutcome(adjudication({ evidence_strength: 'conclusive' }), FRONTEND, resolvesToItself, POLICY);
    const suggestive = deriveOutcome(adjudication({ evidence_strength: 'suggestive' }), FRONTEND, resolvesToItself, POLICY);
    expect(conclusive.confidence).toBe('high');
    expect(suggestive.confidence).toBe('medium');
    expect(suggestive.outcome).toBe('code_fix');
  });

  it('insufficient evidence fails even when the location looks perfect', () => {
    const result = deriveOutcome(adjudication({ evidence_strength: 'insufficient' }), FRONTEND, resolvesToItself, POLICY);
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
    expect(deriveOutcome(padded, FRONTEND, resolvesToItself, POLICY).confidence).toBe('medium');
  });

  it.each<[EvidenceStrength, string]>([
    ['conclusive', 'high'],
    ['suggestive', 'medium'],
  ])('carries %s through to an external conclusion as %s confidence', (strength, expected) => {
    const result = deriveOutcome(
      adjudication({ evidence_strength: strength, cause_kind: 'external_system', cause_locations: ['https://cdn.example.com/app.js'] }),
      FRONTEND,
      resolvesToItself,
      POLICY,
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
    expect(deriveOutcome(b, FRONTEND, resolvesToItself, POLICY).outcome)
      .toBe(deriveOutcome(a, FRONTEND, resolvesToItself, POLICY).outcome);
  });

  it('moving the defect does change where it lands', () => {
    const inside = adjudication({ cause_locations: ['client/asset-panel/src/AssetList.tsx:42'] });
    const outside = adjudication({ cause_locations: ['server/app/routes/api/resources/asset.py:79'] });
    expect(deriveOutcome(inside, FRONTEND, resolvesToItself, POLICY).outcome)
      .not.toBe(deriveOutcome(outside, FRONTEND, resolvesToItself, POLICY).outcome);
  });

  it('an unconfigured surface keeps the pre-existing whole-repository behaviour', () => {
    const result = deriveOutcome(
      adjudication({ cause_locations: ['server/app/routes/api/resources/asset.py:79'] }),
      { globs: null },
      resolvesToItself,
      POLICY,
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
    candidates_considered: [],
    rejected: ['Client retry loop: the requests are minutes apart'],
    evidence_strength: 'suggestive' as const,
    reasoning: 'The 429 is server-issued and no repository code produces it.',
  };

  // The exact string a live run produced. It contains no URL, no HTTP method
  // and no hostname, so prose matching called it vague and lost the answer.
  it('reaches a conclusion for an external cause described in plain words', () => {
    const result = deriveOutcome(
      { ...base, cause_kind: 'external_system', cause_locations: ['upstream API gateway / reverse proxy (not present in repository)'] },
      FRONTEND,
      resolvesToItself,
      POLICY,
    );
    expect(result.outcome).toBe('not_actionable');
  });

  it('reaches a conclusion for a data cause with no location at all', () => {
    const result = deriveOutcome(
      { ...base, cause_kind: 'data_or_input', cause_locations: [''] },
      FRONTEND,
      resolvesToItself,
      POLICY,
    );
    expect(result.outcome).toBe('not_actionable');
  });

  it('fails when the kind is unknown however confident the prose sounds', () => {
    const result = deriveOutcome(
      { ...base, cause_kind: 'unknown', cause_locations: ['client/asset-panel/src/AssetList.tsx:42'] },
      FRONTEND,
      resolvesToItself,
      POLICY,
    );
    expect(result.outcome).toBe('needs_more_context');
  });

  it('still requires a resolvable file when the kind claims local code', () => {
    const result = deriveOutcome(
      { ...base, cause_kind: 'local_code', cause_locations: ['the fetcher module'] },
      FRONTEND,
      resolvesToItself,
      POLICY,
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
      adjudication({ cause_kind: 'local_code', cause_locations: [`${cited}:1`] }),
      FRONTEND,
      resolvesThroughSymlink,
      POLICY,
    );
    expect(result.outcome).toBe('not_actionable');
    expect(result.reason).toContain('server/app/asset.py');
  });

  it('reports the resolved path, not the cited one, when it does authorise a fix', () => {
    const result = deriveOutcome(
      adjudication({ cause_locations: ['client/link.tsx:3'] }),
      FRONTEND,
      () => 'client/real/Component.tsx',
      POLICY,
    );
    expect(result.outcome).toBe('code_fix');
    expect(result.reason).toContain('client/real/Component.tsx');
  });
});

describe('an external conclusion has to be reached against the local candidates', () => {
  const external = adjudication({
    cause_kind: 'external_system',
    cause_locations: ['upstream gateway'],
    candidates_considered: [
      { statement: 'QueryClient retries without a policy', kind: 'local_code' },
      { statement: 'A stale cache key', kind: 'configuration' },
    ],
    rejected: [],
  });

  it('refuses to conclude external while leaving a local candidate unaddressed', () => {
    const result = deriveOutcome(external, FRONTEND, resolvesToItself, POLICY);
    expect(result.outcome).toBe('needs_more_context');
    expect(result.reason).toMatch(/without rejecting/);
    expect(result.reason).toContain('QueryClient retries without a policy');
  });

  it('accepts the conclusion once those candidates are rejected', () => {
    const result = deriveOutcome(
      {
        ...external,
        rejected: [
          'QueryClient retries without a policy: the requests are 11 minutes apart',
          'A stale cache key: the key is derived per request',
        ],
      },
      FRONTEND,
      resolvesToItself,
      POLICY,
    );
    expect(result.outcome).toBe('not_actionable');
  });

  it('does not demand rejections that were never raised', () => {
    const result = deriveOutcome(
      { ...external, candidates_considered: [] },
      FRONTEND,
      resolvesToItself,
      POLICY,
    );
    expect(result.outcome).toBe('not_actionable');
  });
});

const localBase = {
  best_supported: 'A null deref in the panel',
  evidence_check: 'read both files',
  candidates_considered: [{ statement: 'null deref', kind: 'local_code' as const }],
  rejected: [],
  evidence_strength: 'suggestive' as const,
  cause_kind: 'local_code' as const,
  reasoning: 'r',
  why_chain: [],
  reproduction_steps: [],
};

describe('the first citation is the claim', () => {
  it('refuses when the first citation is outside the surface, even if a later one is inside', () => {
    const d = deriveOutcome(
      { ...localBase, cause_locations: ['server/app.py', 'client/App.tsx'] },
      { globs: ['client/**'] }, (c) => c, POLICY,
    );

    expect(d.outcome).toBe('not_actionable');
    expect(d.basis).toBe('primary_outside_fix_surface');
  });

  it('authorizes when the first citation is inside the surface', () => {
    const d = deriveOutcome(
      { ...localBase, cause_locations: ['client/App.tsx', 'server/app.py'] },
      { globs: ['client/**'] }, (c) => c, POLICY,
    );

    expect(d.outcome).toBe('code_fix');
    expect(d.basis).toBe('in_surface_defect');
  });

  // A vague or external first entry must not fall through to a later citation:
  // that is the "any citation authorises" hole wearing a different shape.
  it('does not skip past an unparseable first citation to authorize a later one', () => {
    const d = deriveOutcome(
      { ...localBase, cause_locations: ['somewhere in the render path', 'client/App.tsx'] },
      { globs: ['client/**'] }, (c) => c, POLICY,
    );

    expect(d.outcome).toBe('needs_more_context');
    expect(d.basis).toBe('uncitable_local_claim');
  });
});

describe('external conclusions must reject every local candidate', () => {
  const external = {
    best_supported: 'The upstream gateway timed out',
    evidence_check: 'checked breadcrumb timings',
    evidence_strength: 'suggestive' as const,
    cause_kind: 'external_system' as const,
    cause_locations: ['GET /api/search (remote service)'],
    reasoning: 'r',
    why_chain: [],
    reproduction_steps: [],
  };

  it('accepts when every local candidate is named in the rejections', () => {
    const d = deriveOutcome({
      ...external,
      candidates_considered: [
        { statement: 'A client retry loop', kind: 'local_code' },
        { statement: 'Gateway timeout', kind: 'external_system' },
      ],
      rejected: ['A client retry loop: the counter does reset, verified in src/retry.ts'],
    }, { globs: null }, () => null, POLICY);

    expect(d.outcome).toBe('not_actionable');
    expect(d.basis).toBe('cause_outside_codebase');
  });

  // This is the defect: previously ANY one string in `rejected` satisfied the
  // check, so a model could reject an irrelevant candidate and escape the work.
  it('refuses when a local candidate is left unrejected', () => {
    const d = deriveOutcome({
      ...external,
      candidates_considered: [
        { statement: 'A client retry loop', kind: 'local_code' },
        { statement: 'A stale cache key', kind: 'configuration' },
      ],
      rejected: ['A client retry loop: the counter does reset'],
    }, { globs: null }, () => null, POLICY);

    expect(d.outcome).toBe('needs_more_context');
    expect(d.basis).toBe('unrejected_local_candidates');
    expect(d.reason).toContain('A stale cache key');
  });

  it('accepts when there were no local candidates to reject', () => {
    const d = deriveOutcome({
      ...external,
      candidates_considered: [{ statement: 'Gateway timeout', kind: 'external_system' }],
      rejected: [],
    }, { globs: null }, () => null, POLICY);

    expect(d.outcome).toBe('not_actionable');
  });
});

describe('unconfigured fix surface', () => {
  it('refuses a fix when no surface is configured and policy does not allow it', () => {
    const d = deriveOutcome(
      { ...localBase, cause_locations: ['client/App.tsx'] },
      { globs: null }, (c) => c, { allowUnrestrictedSurface: false },
    );

    expect(d.outcome).toBe('needs_more_context');
    expect(d.basis).toBe('no_fix_surface_configured');
  });
});
