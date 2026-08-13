import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildPRBody,
  CI_STATUS_END,
  CI_STATUS_START,
  VERIFICATION_END,
  VERIFICATION_START,
} from '../pr.js';
import { CANONICAL_PR_INPUT } from './fixtures/pr-body-canonical-input.js';

const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/pr-body-baseline-c2.md', import.meta.url));

if (process.env['UPDATE_PR_BODY_BASELINE']) {
  writeFileSync(FIXTURE_PATH, buildPRBody(CANONICAL_PR_INPUT));
}

describe('PR body C2 baseline', () => {
  it('preserves every pre-C5 section of a human-triggered PR body', () => {
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
    const parse = (body: string) => {
      const chunks = body.split(/(?=^#{2,3} )/m);
      const preambleLines = (chunks[0] ?? '').split('\n').map(normalize).filter(Boolean);
      const sections = new Map<string, string>();
      for (const chunk of chunks.slice(1)) {
        const [heading = '', ...rest] = chunk.split('\n');
        sections.set(heading.trim(), normalize(rest.join('\n')));
      }
      return { preambleLines, sections };
    };

    const currentBody = buildPRBody(CANONICAL_PR_INPUT);
    const baseline = parse(readFileSync(FIXTURE_PATH, 'utf8'));
    const current = parse(currentBody);
    for (const line of baseline.preambleLines) expect(normalize(currentBody)).toContain(line);
    for (const [heading, body] of baseline.sections) {
      expect([...current.sections.keys()]).toContain(heading);
      expect(current.sections.get(heading)).toContain(body);
    }
    for (const marker of [VERIFICATION_START, VERIFICATION_END, CI_STATUS_START, CI_STATUS_END]) {
      expect(currentBody).toContain(marker);
    }
  });
});
