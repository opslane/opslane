import type Anthropic from '@anthropic-ai/sdk';
import type { ClaimedJob } from './db.js';
import { runProductContext } from './product-context/job.js';

export const ROUTE_MAP_PROMPT_VERSION = 1;

const ROUTE_TIERS = ['customer', 'standard', 'admin'] as const;
type RouteTier = (typeof ROUTE_TIERS)[number];

export interface RouteMapRow {
  pattern: string;
  name: string;
  purpose: string;
  tier: RouteTier;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRouteTier(value: unknown): value is RouteTier {
  return typeof value === 'string' && (ROUTE_TIERS as readonly string[]).includes(value);
}

/** Terminal structured-output tool for route classification. */
export function routeMapTerminalTool(): Anthropic.Tool {
  return {
    name: 'submit_route_map',
    description: 'Submit the final route classification. Call exactly once when done.',
    strict: true,
    input_schema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        rows: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              pattern: { type: 'string' },
              name: { type: 'string' },
              purpose: { type: 'string' },
              tier: { type: 'string', enum: ROUTE_TIERS },
            },
            required: ['pattern', 'name', 'purpose', 'tier'],
          },
        },
      },
      required: ['rows'],
    },
  };
}

/** Fence normalized patterns as a JSON data block, never as prompt prose. */
export function buildRouteMapFirstMessage(patterns: string[]): string {
  return `Classify only the normalized route patterns in this data block.

PATTERNS_START
${JSON.stringify(patterns, null, 2)}
PATTERNS_END`;
}

/** Validate the raw submit_route_map input against the exact asked-pattern set. */
export function parseRouteMapSubmission(raw: unknown, asked: string[]): RouteMapRow[] {
  if (!isRecord(raw) || !Array.isArray(raw['rows'])) {
    throw new Error('Route-map submission must be an object with a rows array');
  }
  const allowed = new Set(asked);
  const seen = new Set<string>();
  const rows: RouteMapRow[] = [];

  for (const [index, value] of raw['rows'].entries()) {
    if (!isRecord(value)) throw new Error(`Route-map row ${index} must be an object`);
    const pattern = value['pattern'];
    const name = value['name'];
    const purpose = value['purpose'];
    const tier = value['tier'];
    if (typeof pattern !== 'string' || !allowed.has(pattern)) {
      throw new Error(`Route-map row ${index} contains an unasked pattern`);
    }
    if (seen.has(pattern)) throw new Error(`Route-map submission repeats pattern ${pattern}`);
    if (typeof name !== 'string' || name.trim() === '') {
      throw new Error(`Route-map row ${index} must have a non-empty name`);
    }
    if (typeof purpose !== 'string') {
      throw new Error(`Route-map row ${index} must have a purpose string`);
    }
    if (!isRouteTier(tier)) throw new Error(`Route-map row ${index} has an unknown tier`);
    seen.add(pattern);
    rows.push({ pattern, name: name.trim(), purpose: purpose.trim(), tier });
  }
  return rows;
}

/**
 * Compatibility entry point for the existing route_map queue kind.
 *
 * Slice 6 deepens route classification into product understanding without a
 * queue migration. Queue completion and failure remain owned by poller.ts.
 */
export async function processRouteMapJob(
  job: ClaimedJob,
  signal: AbortSignal,
): Promise<void> {
  await runProductContext(job, signal);
}
