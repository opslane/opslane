import type { Diagnosis } from '@opslane/shared';
import { describe, expect, it } from 'vitest';
import { deriveOutcome } from '../classify.js';

const frontendOnly = { globs: ['client/**'] };
const allFilesExist = () => true;

function diagnosis(overrides: Partial<Diagnosis> = {}): Diagnosis {
  return {
    one_line_description: 'Null dereference rendering the asset list',
    why_chain: ['Asset list renders before fetch resolves', 'assets is null', 'map throws'],
    reproduction_steps: ['Open the panel with a slow network'],
    cause_location: 'client/asset-panel/src/AssetList.tsx:42',
    ...overrides,
  };
}

describe('deriveOutcome', () => {
  it('routes a defect inside the surface to code_fix', () => {
    expect(deriveOutcome(diagnosis(), frontendOnly, allFilesExist).outcome).toBe('code_fix');
  });

  it('routes a recognised external cause to not_actionable', () => {
    const result = deriveOutcome(
      diagnosis({ cause_location: 'GET /issue-context/api/assets/search (remote service)' }),
      frontendOnly,
      allFilesExist,
    );
    expect(result.outcome).toBe('not_actionable');
  });

  it.each([
    'unknown',
    'probably the backend',
    'could not locate the cause',
    'somewhere in the API layer',
    'src/api',
  ])('routes vague location %j to needs_more_context', (location) => {
    expect(deriveOutcome(diagnosis({ cause_location: location }), frontendOnly, allFilesExist).outcome)
      .toBe('needs_more_context');
  });

  it('accepts a repository-root file as a citation', () => {
    expect(deriveOutcome(diagnosis({ cause_location: 'package.json:12' }), { globs: null }, allFilesExist).outcome)
      .toBe('code_fix');
  });

  it('accepts a ./-prefixed citation', () => {
    expect(deriveOutcome(
      diagnosis({ cause_location: './client/asset-panel/src/AssetList.tsx:42' }),
      frontendOnly,
      allFilesExist,
    ).outcome).toBe('code_fix');
  });

  it('only opens a PR unattended when the diagnosis is solid', () => {
    const thin = diagnosis({ why_chain: ['it broke'], reproduction_steps: [], cause_location: 'client/a/b.tsx' });
    expect(deriveOutcome(thin, frontendOnly, allFilesExist).confidence).toBe('medium');
    expect(deriveOutcome(diagnosis(), frontendOnly, allFilesExist).confidence).toBe('high');
  });

  it('routes a real defect outside the surface to not_actionable', () => {
    const result = deriveOutcome(
      diagnosis({ cause_location: 'server/app/routes/api/resources/asset.py:79' }),
      frontendOnly,
      allFilesExist,
    );
    expect(result.outcome).toBe('not_actionable');
    expect(result.reason).toMatch(/outside the configured fix surface/);
  });

  it('routes a missing diagnosis to needs_more_context', () => {
    expect(deriveOutcome(null, frontendOnly, allFilesExist).outcome).toBe('needs_more_context');
  });

  it('routes an uncheckable citation to needs_more_context', () => {
    const result = deriveOutcome(
      diagnosis({ cause_location: 'client/asset-panel/src/Ghost.tsx:9' }),
      frontendOnly,
      () => false,
    );
    expect(result.outcome).toBe('needs_more_context');
    expect(result.reason).toMatch(/does not exist/);
  });

  it('keeps the route unchanged when diagnosis prose is reworded', () => {
    const reworded = diagnosis({
      one_line_description: 'The asset list blows up on a null collection',
      why_chain: ['Render happens first', 'The collection is null', 'Calling map on null throws'],
      reproduction_steps: ['Load the panel on a throttled connection'],
    });
    expect(deriveOutcome(reworded, frontendOnly, allFilesExist).outcome)
      .toBe(deriveOutcome(diagnosis(), frontendOnly, allFilesExist).outcome);
  });

  it('changes the route when the defect location changes', () => {
    const inside = diagnosis({ cause_location: 'client/asset-panel/src/AssetList.tsx:42' });
    const outside = diagnosis({ cause_location: 'server/app/routes/api/resources/asset.py:79' });
    expect(deriveOutcome(inside, frontendOnly, allFilesExist).outcome)
      .not.toBe(deriveOutcome(outside, frontendOnly, allFilesExist).outcome);
  });

  it('preserves whole-repository behavior when the surface is unconfigured', () => {
    const result = deriveOutcome(
      diagnosis({ cause_location: 'server/app/routes/api/resources/asset.py:79' }),
      { globs: null },
      allFilesExist,
    );
    expect(result.outcome).toBe('code_fix');
  });

  it('never answers not_actionable merely because evidence is thin', () => {
    const thin = diagnosis({ why_chain: ['something went wrong'], cause_location: '' });
    expect(deriveOutcome(thin, frontendOnly, allFilesExist).outcome).toBe('needs_more_context');
  });

  it('rejects a directory cited as if it were a file', () => {
    const result = deriveOutcome(
      diagnosis({ cause_location: 'client/asset-panel/src/AssetList.tsx' }),
      frontendOnly,
      () => false,
    );
    expect(result.outcome).toBe('needs_more_context');
  });
});
