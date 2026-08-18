import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { routeClaimsTerminalTool } from '../product-context/schema.js';
import { routeMapTerminalTool } from '../route-map.js';
import { submitDiagnosisTool } from '../diagnose-schema.js';
import { CLASSIFY_TOOL } from '../friction/investigate-friction.js';

// Anthropic strict tools reject minimum/maximum on numbers at request time
// with invalid_request_error, which dead-letters every job using the tool
// while stub-based tests stay green (Slice 6 verification, AC5/AC11).
// This scan is the offline half of the guard; tool-contracts.live.test.ts is
// the live half. New strict tools must be added to STRICT_TOOLS in both.
const STRICT_TOOLS: Anthropic.Tool[] = [
  routeClaimsTerminalTool(),
  routeMapTerminalTool(),
  submitDiagnosisTool(),
  CLASSIFY_TOOL,
];

function collectKeys(value: unknown, found: Set<string>): void {
  if (Array.isArray(value)) { value.forEach((v) => collectKeys(v, found)); return; }
  if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) { found.add(k); collectKeys(v, found); }
  }
}

describe('strict tool schemas avoid API-rejected keywords', () => {
  for (const tool of STRICT_TOOLS) {
    it(`${tool.name} uses no minimum/maximum`, () => {
      const keys = new Set<string>();
      collectKeys(tool.input_schema, keys);
      expect(keys.has('minimum')).toBe(false);
      expect(keys.has('maximum')).toBe(false);
    });
  }

  it('states the 0-1 confidence contract in the description instead', () => {
    const text = JSON.stringify(routeClaimsTerminalTool().input_schema);
    expect(text).toContain('0 (could not ground)');
    expect(text).toContain('1 (certain)');
  });
});
