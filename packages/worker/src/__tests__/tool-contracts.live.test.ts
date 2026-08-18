import { describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { routeClaimsTerminalTool } from '../product-context/schema.js';
import { routeMapTerminalTool } from '../route-map.js';
import { submitDiagnosisTool } from '../diagnose-schema.js';
import { CLASSIFY_TOOL } from '../friction/investigate-friction.js';

const apiKey = process.env['ANTHROPIC_API_KEY'];

// Live half of the strict-schema guard (offline half: strict-tool-schemas.test.ts).
// Gated on ANTHROPIC_API_KEY like the DB suites are gated on DATABASE_URL: a
// keyless environment reports SKIPPED, and release verification must run it
// with a key (root AGENTS.md: read the skip count).
describe.skipIf(!apiKey)('strict tool schemas are accepted by the Anthropic API', () => {
  const tools: Anthropic.Tool[] = [
    routeClaimsTerminalTool(),
    routeMapTerminalTool(), // vestigial (route_map jobs run the product-context path) but still declared strict
    submitDiagnosisTool(),
    CLASSIFY_TOOL,
  ];

  for (const tool of tools) {
    it(`accepts ${tool.name}`, async () => {
      const client = new Anthropic({ apiKey: apiKey! });
      try {
        const response = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 16,
          tools: [tool],
          messages: [{ role: 'user', content: 'Reply with any text.' }],
        });
        expect(response.type).toBe('message');
      } catch (error: unknown) {
        // Only a 400 whose message points at the tools block is a schema
        // verdict; any other failure (auth, rate limit, outage, unrelated 400)
        // is inconclusive and must not masquerade as one.
        if (error instanceof Anthropic.APIError && error.status === 400 && /tools/i.test(error.message)) {
          throw new Error(`schema for ${tool.name} rejected by the API: ${error.message}`);
        }
        throw new Error(`live check inconclusive for ${tool.name} (not a schema verdict): ${String(error)}`);
      }
    }, 30_000);
  }
});
