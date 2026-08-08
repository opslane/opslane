import { describe, expect, it } from 'vitest';
import {
  buildRouteMapFirstMessage,
  parseRouteMapSubmission,
  routeMapTerminalTool,
} from '../route-map.js';

const ASKED = ['/assets/:id', '/portal/panel'];

describe('parseRouteMapSubmission', () => {
  it('accepts valid rows', () => {
    expect(parseRouteMapSubmission({ rows: [
      { pattern: '/assets/:id', name: 'Asset detail', purpose: 'Manage an asset', tier: 'standard' },
      { pattern: '/portal/panel', name: 'Portal panel', purpose: 'Help a customer', tier: 'customer' },
    ] }, ASKED)).toEqual([
      { pattern: '/assets/:id', name: 'Asset detail', purpose: 'Manage an asset', tier: 'standard' },
      { pattern: '/portal/panel', name: 'Portal panel', purpose: 'Help a customer', tier: 'customer' },
    ]);
  });

  it('rejects unknown tiers', () => {
    expect(() => parseRouteMapSubmission({ rows: [
      { pattern: '/assets/:id', name: 'Assets', purpose: '', tier: 'revenue' },
    ] }, ASKED)).toThrow(/unknown tier/);
  });

  it('rejects hallucinated patterns not in the asked set', () => {
    expect(() => parseRouteMapSubmission({ rows: [
      { pattern: '/made-up', name: 'Made up', purpose: '', tier: 'standard' },
    ] }, ASKED)).toThrow(/unasked pattern/);
  });

  it('tolerates partial classification', () => {
    expect(parseRouteMapSubmission({ rows: [
      { pattern: '/assets/:id', name: 'Assets', purpose: '', tier: 'standard' },
    ] }, ASKED)).toHaveLength(1);
  });

  it.each([
    {},
    { rows: {} },
    { rows: [null] },
    { rows: [{ pattern: '/assets/:id', purpose: '', tier: 'standard' }] },
    { rows: [{ pattern: '/assets/:id', name: 'Assets', tier: 'standard' }] },
  ])('rejects malformed input %#', (raw) => {
    expect(() => parseRouteMapSubmission(raw, ASKED)).toThrow();
  });

  it('rejects duplicate classifications for one pattern', () => {
    const row = { pattern: '/assets/:id', name: 'Assets', purpose: '', tier: 'standard' };
    expect(() => parseRouteMapSubmission({ rows: [row, row] }, ASKED)).toThrow(/repeats pattern/);
  });
});

describe('routeMapTerminalTool', () => {
  it('declares a strict rows schema with the route fields and tier enum', () => {
    const tool = routeMapTerminalTool();
    expect(tool.name).toBe('submit_route_map');
    const schema = tool.input_schema as Record<string, unknown>;
    const rows = (schema['properties'] as Record<string, Record<string, unknown>>)['rows']!;
    const item = rows['items'] as Record<string, unknown>;
    expect(item['required']).toEqual(['pattern', 'name', 'purpose', 'tier']);
    const properties = item['properties'] as Record<string, Record<string, unknown>>;
    expect(properties['tier']?.['enum']).toEqual(['customer', 'standard', 'admin']);
  });
});

describe('buildRouteMapFirstMessage', () => {
  it('embeds each pattern once between data delimiters', () => {
    const message = buildRouteMapFirstMessage(ASKED);
    const fenced = message.split('PATTERNS_START\n')[1]?.split('\nPATTERNS_END')[0];
    expect(fenced).toBeDefined();
    for (const pattern of ASKED) {
      expect(fenced!.split(pattern)).toHaveLength(2);
    }
  });
});
