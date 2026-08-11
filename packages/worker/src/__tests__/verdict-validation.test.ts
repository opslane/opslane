import { describe, expect, it } from 'vitest';
import { FILLER_VERDICT, validateVerdict } from '../verdict-validation.js';

const CITE = {
  path: 'src/a.ts',
  detail: 'unkeyed v-for remounts the select',
  symptomLink: 'clicks land on a detached node',
};
const BASE = {
  causeText: 'The select remounts because options are rebuilt.',
  claimsCodeCause: true,
  evidence: [CITE],
  agentTaskBrief: '## Symptom\nThe click misses after a remount.',
  filesRead: ['src/a.ts', 'src/b.ts'],
};
const resolveAll = (path: string): string => path;
const resolveNone = (): null => null;

describe('validateVerdict', () => {
  it('accepts a cited, briefed code-cause verdict whose citations were read', () => {
    expect(validateVerdict(BASE, resolveAll)).toEqual({ status: 'valid' });
  });

  it('rejects a run that read no files before any other check', () => {
    const result = validateVerdict({ ...BASE, filesRead: [], causeText: 'placeholder' }, resolveAll);
    expect(result).toMatchObject({ status: 'incomplete', reason: expect.stringMatching(/^no_files_read:/) });
  });

  it('rejects empty and filler cause prose', () => {
    expect(validateVerdict({ ...BASE, causeText: '  ' }, resolveAll)).toMatchObject({
      status: 'incomplete', reason: expect.stringMatching(/^empty_verdict:/),
    });
    expect(validateVerdict({ ...BASE, causeText: 'placeholder while I continue reading' }, resolveAll)).toMatchObject({
      status: 'incomplete', reason: expect.stringMatching(/^filler_verdict:/),
    });
  });

  it('requires citations for code and non-code causes', () => {
    expect(validateVerdict({ ...BASE, evidence: [] }, resolveAll)).toMatchObject({
      status: 'incomplete', reason: expect.stringMatching(/^no_citations:/),
    });
    expect(validateVerdict({ ...BASE, claimsCodeCause: false, agentTaskBrief: null, evidence: [] }, resolveAll)).toMatchObject({
      status: 'incomplete', reason: expect.stringMatching(/^no_citations:/),
    });
  });

  it('requires a non-filler brief for a code cause', () => {
    expect(validateVerdict({ ...BASE, agentTaskBrief: null }, resolveAll)).toMatchObject({
      status: 'incomplete', reason: expect.stringMatching(/^missing_brief:/),
    });
    expect(validateVerdict({ ...BASE, agentTaskBrief: 'tbd' }, resolveAll)).toMatchObject({
      status: 'incomplete', reason: expect.stringMatching(/^filler_brief:/),
    });
  });

  it('rejects malformed and unlinked citations in order', () => {
    expect(validateVerdict({ ...BASE, evidence: [{ ...CITE, path: '  ' }] }, resolveAll)).toMatchObject({
      status: 'incomplete', reason: expect.stringMatching(/^citation_malformed:/),
    });
    expect(validateVerdict({ ...BASE, evidence: [{ ...CITE, symptomLink: '' }] }, resolveAll)).toMatchObject({
      status: 'incomplete', reason: expect.stringMatching(/^citation_missing_link: src\/a\.ts/),
    });
  });

  it('rejects citations absent from the checkout or unread by the agent', () => {
    expect(validateVerdict(BASE, resolveNone)).toMatchObject({
      status: 'incomplete', reason: expect.stringMatching(/^citation_unresolvable: src\/a\.ts/),
    });
    expect(validateVerdict({ ...BASE, evidence: [{ ...CITE, path: 'src/never-read.ts' }] }, resolveAll)).toMatchObject({
      status: 'incomplete', reason: expect.stringMatching(/^citation_not_read: src\/never-read\.ts/),
    });
  });

  it('checks citations on non-code-cause verdicts too', () => {
    expect(validateVerdict({ ...BASE, claimsCodeCause: false, agentTaskBrief: null }, resolveNone)).toMatchObject({
      status: 'incomplete', reason: expect.stringMatching(/^citation_unresolvable:/),
    });
  });

  it('matches the known filler artifacts and spares legitimate placeholder-mentioning prose', () => {
    expect(FILLER_VERDICT.test('placeholder')).toBe(true);
    expect(FILLER_VERDICT.test('placeholder while I continue reading')).toBe(true);
    expect(FILLER_VERDICT.test('  TBD')).toBe(true);
    expect(FILLER_VERDICT.test('to be determined once logs arrive')).toBe(true);
    // Anchored like migration 045's SQL regex: friction verdicts legitimately
    // discuss UI placeholder text; a mid-prose mention is not filler. The
    // unanchored form destroyed 1 of 8 real verdicts in the 2026-08-11
    // prod-copy rehearsal.
    expect(FILLER_VERDICT.test('The placeholder text in the input is misrendered')).toBe(false);
    expect(FILLER_VERDICT.test('The Select shows placeholder text because no option is chosen')).toBe(false);
  });
});
