import { describe, expect, it } from 'vitest';
import { submitDiagnosisTool, EVIDENCE_ARRAY_SCHEMA } from '../diagnose-schema.js';
import { readOnlyTools } from '../harness/sdk-agent.js';
import { inquiryDecisionTerminalTool } from '../inquiry/schema.js';
import { routeMapTerminalTool } from '../route-map.js';
import { routeClaimsTerminalTool } from '../product-context/schema.js';
import { CLASSIFY_TOOL } from '../friction/investigate-friction.js';
import { createToolBridge } from '../harness/tool-bridge.js';

/**
 * The Anthropic API rejects array bounds in custom tool input schemas with
 * 400 invalid_request_error ("For 'array' type, property 'maxItems' is not
 * supported"). One such keyword anywhere in a tool schema kills every call on
 * that lane at turn zero — in production this silently replaced all
 * investigations with "could not reach the model" terminals for a week.
 * Bounds belong in the parser/handler layer, never on the wire schema.
 */
const FORBIDDEN_ARRAY_KEYWORDS = ['minItems', 'maxItems', 'uniqueItems', 'contains'];

function forbiddenKeywordPaths(node: unknown, path: string, out: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((entry, i) => forbiddenKeywordPaths(entry, `${path}[${i}]`, out));
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  for (const [key, value] of Object.entries(node)) {
    if (FORBIDDEN_ARRAY_KEYWORDS.includes(key)) out.push(`${path}.${key}`);
    forbiddenKeywordPaths(value, `${path}.${key}`, out);
  }
}

function expectClean(name: string, schema: unknown): void {
  const hits: string[] = [];
  forbiddenKeywordPaths(schema, name, hits);
  expect(hits, `${name} carries array-bound keywords the API rejects`).toEqual([]);
}

describe('Anthropic tool schemas carry no array-bound keywords', () => {
  it('investigation terminal tool', () => {
    expectClean('submit_diagnosis', submitDiagnosisTool().input_schema);
  });

  it('shared evidence citation schema', () => {
    expectClean('EVIDENCE_ARRAY_SCHEMA', EVIDENCE_ARRAY_SCHEMA);
  });

  it('read-only repository tools', () => {
    for (const tool of readOnlyTools()) expectClean(tool.name, tool.input_schema);
  });

  it('inquiry terminal tool', () => {
    expectClean('inquiry', inquiryDecisionTerminalTool().input_schema);
  });

  it('route-map terminal tool', () => {
    expectClean('route_map', routeMapTerminalTool().input_schema);
  });

  it('product-context terminal tool', () => {
    expectClean('route_claims', routeClaimsTerminalTool().input_schema);
  });

  it('friction classify tool', () => {
    expectClean('classify_friction', CLASSIFY_TOOL.input_schema);
  });

  it('fix agent sandbox tools', () => {
    // Build-time inspection only: the bridge closes over sandbox/state inside
    // execute handlers, which this test never calls.
    const tools = createToolBridge({} as never, {} as never);
    for (const tool of tools) expectClean(tool.name, tool.inputSchema);
  });
});
