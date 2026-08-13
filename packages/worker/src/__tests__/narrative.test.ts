import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { EvidenceRecord } from '@opslane/shared';
import {
  buildFallbackNarrative,
  buildIncidentUrl,
  buildSessionUrl,
  escapeInlineCode,
  normalizeProse,
  normalizeSubject,
  parseFixNarrative,
  renderCommitMessage,
  renderPRSections,
  storyLine,
} from '../narrative.js';

interface StoryVector {
  name: string;
  nounSingular: string;
  nounPlural: string;
  occurrences: number;
  impact: { class: string | null; visits: number | null; recovered: number | null };
  want: string;
}

const storyVectors = JSON.parse(readFileSync(fileURLToPath(
  new URL('../../../../test-fixtures/story-vectors.json', import.meta.url),
), 'utf8')) as StoryVector[];

const fallbackInput = {
  errorType: 'TypeError',
  errorMessage: "Cannot destructure property 'name' of 'props.user.profile' as it is null",
  primaryFile: 'src/components/UserCard.vue',
};

const narrative = {
  subject: 'Guard null profiles in UserCard',
  whatHappened: 'Clicking Edit Profile for a user without a profile crashed the page.',
  whyItBroke: 'UserCard destructured a nullable profile before checking it.',
  fixApproach: 'Return early when the profile is absent, matching the declared nullable type.',
};

const evidence: EvidenceRecord = {
  version: 1,
  tier: 'E1',
  checks: [
    { name: 'build', outcome: 'failed', command: 'pnpm build', output_tail: '' },
    { name: 'build', outcome: 'passed', command: 'pnpm build', output_tail: '' },
    { name: 'suite_baseline', outcome: 'failed', command: 'pnpm test', output_tail: '' },
    { name: 'suite_post_patch', outcome: 'passed', command: 'pnpm test', output_tail: '' },
  ],
  suite: { baseline_failed_tests: ['legacy.test.ts::fails'], new_failures: [] },
};

describe('narrative validators', () => {
  it('normalizes subjects for their slot without markdown or mid-word truncation', () => {
    expect(normalizeSubject('## Fix the extremely long broken behavior in UserCard when profile data is unavailable.')).toBe(
      'Fix the extremely long broken behavior in UserCard when profile data is…',
    );
  });

  it.each([
    ['markdown fixture', '## Summary **Root Cause:** The profile is null. ```typescript if (!profile) return; ```'],
    ['half-open fence', '## Root cause\n```typescript\nif (!profile) return; The page stays usable.'],
    ['secret-bearing text', 'The token ghp_SUPERSECRET leaked while the profile was missing.'],
    ['dev path', 'The crash came from http://localhost:5173/@fs/Users/abhi/project/src/UserCard.vue.'],
  ])('normalizes %s as bounded prose', (_name, value) => {
    const normalized = normalizeProse(value, 90);
    expect(normalized.length).toBeLessThanOrEqual(90);
    expect(normalized).not.toMatch(/#{2}|```|ghp_|localhost|\/Users\//);
  });

  it('truncates punctuation-free prose at a word boundary with an ellipsis', () => {
    const normalized = normalizeProse(`start ${'unbroken '.repeat(2_000)}`, 80);
    expect(normalized.length).toBeLessThanOrEqual(80);
    expect(normalized).toMatch(/…$/);
    expect(normalized).not.toMatch(/unbro…$/);
  });

  it('escapes inline code without allowing a nested code span', () => {
    expect(escapeInlineCode('src/`unsafe`.ts')).toBe("`src/'unsafe'.ts`");
  });

  it('accepts a complete valid narrative', () => {
    expect(parseFixNarrative(narrative, fallbackInput)).toEqual(narrative);
  });

  it.each([
    { ...narrative, subject: `${narrative.subject}.` },
    { ...narrative, subject: fallbackInput.errorMessage },
    { ...narrative, subject: 'UserCard null profile handling' },
    { ...narrative, whyItBroke: '' },
    { ...narrative, whatHappened: '#'.repeat(800) },
  ])('falls back as one object when any field is invalid', (candidate) => {
    expect(parseFixNarrative(candidate, fallbackInput)).toEqual(buildFallbackNarrative(fallbackInput));
  });
});

describe('narrative renderers', () => {
  it.each(storyVectors)('mirrors the Go story vector: $name', (vector) => {
    expect(storyLine(vector.nounSingular, vector.nounPlural, vector.occurrences, vector.impact)).toBe(vector.want);
  });

  it.each([3.5, Number.NaN])('fails closed for a non-integral visit count: %s', (visits) => {
    expect(storyLine('crash', 'crashes', 12, { class: 'degraded', visits, recovered: 1 }))
      .toBe('12 crashes; recording impact unavailable');
  });

  it('builds only validated session URLs', () => {
    // project_id rides the link: the session page resolves its project from
    // the query, and an external PR reviewer has no localStorage fallback.
    expect(buildSessionUrl('https://app.opslane.com', 'a/b', 123, 'p-1'))
      .toBe('https://app.opslane.com/sessions/a%2Fb?t=123&project_id=p-1');
    for (const base of [undefined, 'http://localhost:5173', 'ftp://app.opslane.com']) {
      expect(buildSessionUrl(base, 's1', 123, 'p-1')).toBeNull();
    }
    for (const anchor of [Number.NaN, -1, 1.5, Infinity, 2 ** 53]) {
      expect(buildSessionUrl('https://app.opslane.com', 's1', anchor, 'p-1')).toBeNull();
    }
    expect(buildSessionUrl('https://app.opslane.com', 's1', 123, '')).toBeNull();
  });

  it('renders one shared subject into PR sections', () => {
    expect(renderPRSections(narrative)).toEqual({
      title: '🛡️ Guard null profiles in UserCard',
      whatHappened: narrative.whatHappened,
      whyItBroke: narrative.whyItBroke,
      fixApproach: narrative.fixApproach,
    });
  });

  it('renders a wrapped commit body using only latest passing check outcomes', () => {
    const message = renderCommitMessage(narrative, evidence, 'https://app.opslane.com/incidents/eg-1');
    const [subject, blank, ...body] = message.split('\n');

    expect(subject).toBe(narrative.subject);
    expect(blank).toBe('');
    expect(body.every((line) => line.length <= 72)).toBe(true);
    expect(message).toContain('Verified: no new test failures compared with the pre-fix baseline;');
    expect(message.replace(/\s+/g, ' ')).toContain('build passed.');
    expect(message).not.toContain('1 test');
    expect(message).toContain('Full incident, session replay, and evidence:');
  });

  it('omits verification and incident paragraphs when no claims or URL exist', () => {
    const message = renderCommitMessage(narrative, null, null);
    expect(message).not.toContain('Verified:');
    expect(message).not.toContain('Full incident');
  });

  it.each([
    ['https://app.opslane.com/', 'https://app.opslane.com/incidents/eg%2F1?project_id=project%20one'],
    ['http://dashboard.internal', 'http://dashboard.internal/incidents/eg%2F1?project_id=project%20one'],
    ['http://localhost:5173', null],
    ['https://127.0.0.1', null],
    ['ftp://app.opslane.com', null],
    ['not a URL', null],
  ])('applies the incident URL policy to %s', (base, expected) => {
    expect(buildIncidentUrl(base, 'eg/1', 'project one')).toBe(expected);
  });
});
