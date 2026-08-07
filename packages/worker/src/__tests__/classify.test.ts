import type { Adjudication, EvidenceStrength } from '@opslane/shared';
import { describe, expect, it } from 'vitest';
import { deriveOutcome } from '../classify.js';

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
    cause_locations: [{ path: 'client/asset-panel/src/AssetList.tsx', line: 42 }],
    reasoning: 'The cited line dereferences assets without a null guard.',
    ...overrides,
  };
}

describe('deriveOutcome routing', () => {
  it('routes a verified local defect to code_fix', () => {
    expect(deriveOutcome(adjudication(), resolvesToItself).outcome).toBe('code_fix');
  });

  it('routes a recognised external cause to not_actionable', () => {
    const result = deriveOutcome(
      adjudication({ cause_kind: 'external_system', cause_locations: [{ path: 'GET /issue-context/api/assets/search', note: 'remote service' }] }),
      resolvesToItself,
    );
    expect(result.outcome).toBe('not_actionable');
  });

  it('routes a missing adjudication to needs_more_context', () => {
    expect(deriveOutcome(null, resolvesToItself).outcome).toBe('needs_more_context');
  });

  it('routes an uncheckable citation to needs_more_context, never a conclusion', () => {
    const result = deriveOutcome(
      adjudication({ cause_locations: [{ path: 'client/asset-panel/src/Ghost.tsx', line: 9 }] }),
      () => null,
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
  ])('routes a local claim whose path %j is not a file to needs_more_context', (path) => {
    // Locations arrive structured now, so there is no "unparseable" citation to
    // reject up front: whatever the model puts in `path` is checked against the
    // filesystem. Prose in that field fails here, which is the stronger check —
    // it cannot be satisfied by a string that merely looks path-shaped.
    // The resolver answers honestly rather than returning null for everything:
    // a real path routes to code_fix, so the table values above are what make
    // this fail. With a blanket `() => null` the rows asserted nothing.
    const real = 'client/asset-panel/src/AssetList.tsx';
    const honest = (cited: string): string | null => (cited === real ? cited : null);

    const result = deriveOutcome(
      adjudication({ cause_kind: 'local_code', cause_locations: [{ path }] }),
      honest,
    );
    expect(result.outcome).toBe('needs_more_context');
    expect(result.basis).toBe('citation_unresolvable');

    // Same resolver, a path that does exist: proves the resolver is not just
    // rejecting everything.
    expect(deriveOutcome(adjudication({ cause_locations: [{ path: real }] }), honest).outcome)
      .toBe('code_fix');
  });

  it('routes a local claim with no location at all to needs_more_context', () => {
    const result = deriveOutcome(
      adjudication({ cause_kind: 'local_code', cause_locations: [] }),
      resolvesToItself,
    );
    expect(result.outcome).toBe('needs_more_context');
    expect(result.basis).toBe('uncitable_local_claim');
  });
});

describe('evidence strength gates what the pipeline may do', () => {
  it('only conclusive evidence opens a pull request unattended', () => {
    const conclusive = deriveOutcome(adjudication({ evidence_strength: 'conclusive' }), resolvesToItself);
    const suggestive = deriveOutcome(adjudication({ evidence_strength: 'suggestive' }), resolvesToItself);
    expect(conclusive.confidence).toBe('high');
    expect(suggestive.confidence).toBe('medium');
    expect(suggestive.outcome).toBe('code_fix');
  });

  it('insufficient evidence fails even when the location looks perfect', () => {
    const result = deriveOutcome(adjudication({ evidence_strength: 'insufficient' }), resolvesToItself);
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
    expect(deriveOutcome(padded, resolvesToItself).confidence).toBe('medium');
  });

  it.each<[EvidenceStrength, string]>([
    ['conclusive', 'high'],
    ['suggestive', 'medium'],
  ])('carries %s through to an external conclusion as %s confidence', (strength, expected) => {
    const result = deriveOutcome(
      adjudication({ evidence_strength: strength, cause_kind: 'external_system', cause_locations: [{ path: 'https://cdn.example.com/app.js' }] }),
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
    expect(deriveOutcome(b, resolvesToItself).outcome)
      .toBe(deriveOutcome(a, resolvesToItself).outcome);
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
      { ...base, cause_kind: 'external_system', cause_locations: [{ path: 'upstream API gateway / reverse proxy', note: 'not present in repository' }] },
      resolvesToItself,
    );
    expect(result.outcome).toBe('not_actionable');
  });

  it('reaches a conclusion for a data cause with no location at all', () => {
    const result = deriveOutcome(
      { ...base, cause_kind: 'data_or_input', cause_locations: [{ path: '' }] },
      resolvesToItself,
    );
    expect(result.outcome).toBe('not_actionable');
  });

  it('fails when the kind is unknown however confident the prose sounds', () => {
    const result = deriveOutcome(
      { ...base, cause_kind: 'unknown', cause_locations: [{ path: 'client/asset-panel/src/AssetList.tsx', line: 42 }] },
      resolvesToItself,
    );
    expect(result.outcome).toBe('needs_more_context');
  });

  it('still requires a resolvable file when the kind claims local code', () => {
    const result = deriveOutcome(
      { ...base, cause_kind: 'local_code', cause_locations: [{ path: 'the fetcher module' }] },
      () => null,
    );
    expect(result.outcome).toBe('needs_more_context');
  });
});

describe('routing reports the resolved path, not the cited one', () => {
  it('names where the citation actually landed', () => {
    const result = deriveOutcome(
      adjudication({ cause_locations: [{ path: 'client/link.tsx', line: 3 }] }),
      () => 'client/real/Component.tsx',
    );
    expect(result.outcome).toBe('code_fix');
    expect(result.reason).toContain('client/real/Component.tsx');
  });
});

describe('an external conclusion has to be reached against the local candidates', () => {
  const external = adjudication({
    cause_kind: 'external_system',
    cause_locations: [{ path: 'upstream gateway' }],
    candidates_considered: [
      { statement: 'QueryClient retries without a policy', kind: 'local_code' },
      { statement: 'A stale cache key', kind: 'configuration' },
    ],
    rejected: [],
  });

  it('refuses to conclude external while leaving a local candidate unaddressed', () => {
    const result = deriveOutcome(external, resolvesToItself);
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
      resolvesToItself,
    );
    expect(result.outcome).toBe('not_actionable');
  });

  it('does not demand rejections that were never raised', () => {
    const result = deriveOutcome(
      { ...external, candidates_considered: [] },
      resolvesToItself,
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
  it('acts on the first citation, not a later one that also resolves', () => {
    const d = deriveOutcome(
      { ...localBase, cause_locations: [{ path: 'client/App.tsx' }, { path: 'server/app.py' }] },
      (c) => c,
    );

    expect(d.outcome).toBe('code_fix');
    expect(d.basis).toBe('local_defect');
    expect(d.reason).toContain('client/App.tsx');
  });

  // A vague or external first entry must not fall through to a later citation:
  // that is the "any citation authorises" hole wearing a different shape.
  // The hole this closes: a first citation that fails must not be rescued by a
  // later one that happens to resolve. Scanning the list is how a diagnosis
  // whose real cause was elsewhere got authorised by an incidental mention.
  it('does not skip past a failing first citation to authorize a later one', () => {
    const d = deriveOutcome(
      { ...localBase, cause_locations: [{ path: 'nope/missing.tsx' }, { path: 'client/App.tsx' }] },
      (c) => (c === 'client/App.tsx' ? c : null),
    );

    expect(d.outcome).toBe('needs_more_context');
    expect(d.basis).toBe('citation_unresolvable');
  });

  // The first citation is checked against the filesystem, not taken on trust.
  it('refuses when the first citation resolves to nothing', () => {
    const d = deriveOutcome(
      { ...localBase, cause_locations: [{ path: 'client/Ghost.tsx' }, { path: 'client/App.tsx' }] },
      () => null,
    );

    expect(d.outcome).toBe('needs_more_context');
    expect(d.basis).toBe('citation_unresolvable');
  });
});

describe('external conclusions must reject every local candidate', () => {
  const external = {
    best_supported: 'The upstream gateway timed out',
    evidence_check: 'checked breadcrumb timings',
    evidence_strength: 'suggestive' as const,
    cause_kind: 'external_system' as const,
    cause_locations: [{ path: 'GET /api/search', note: 'remote service' }],
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
    }, () => null);

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
    }, () => null);

    expect(d.outcome).toBe('needs_more_context');
    expect(d.basis).toBe('unrejected_local_candidates');
    expect(d.reason).toContain('A stale cache key');
  });

  it('accepts when there were no local candidates to reject', () => {
    const d = deriveOutcome({
      ...external,
      candidates_considered: [{ statement: 'Gateway timeout', kind: 'external_system' }],
      rejected: [],
    }, () => null);

    expect(d.outcome).toBe('not_actionable');
  });
});
