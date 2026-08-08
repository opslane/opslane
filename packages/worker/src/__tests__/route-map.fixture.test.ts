import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildRouteMapFirstMessage, parseRouteMapSubmission } from '../route-map.js';

// The fixture currently mounts a single Vue app directly and has no client
// router. Its one effective browser route is therefore the observed root path.
const FIXTURE_ROOT = fileURLToPath(new URL('../../../../test-fixtures/vue-app/', import.meta.url));
const EXPECTED_PATTERNS = ['/'];

describe('Vue fixture route-map parser/prompt contract', () => {
  it('uses the fixture-derived root route and validates canned classification output', async () => {
    const main = await readFile(`${FIXTURE_ROOT}src/main.ts`, 'utf8');
    expect(main).toContain('createApp(App)');
    expect(main).not.toContain('createRouter');

    const rows = parseRouteMapSubmission({ rows: [{
      pattern: '/',
      name: 'Fixture application',
      purpose: 'Exercise browser error and friction fixtures',
      tier: 'standard',
    }] }, EXPECTED_PATTERNS);

    expect(rows).toHaveLength(EXPECTED_PATTERNS.length);
    for (const row of rows) {
      expect(['customer', 'standard', 'admin']).toContain(row.tier);
      expect(EXPECTED_PATTERNS).toContain(row.pattern);
      expect(row.name).not.toBe('');
    }

    const message = buildRouteMapFirstMessage(EXPECTED_PATTERNS);
    const fenced = message.split('PATTERNS_START\n')[1]?.split('\nPATTERNS_END')[0];
    expect(fenced).toBeDefined();
    for (const pattern of EXPECTED_PATTERNS) {
      expect(fenced!.split(`"${pattern}"`)).toHaveLength(2);
    }
  });
});
