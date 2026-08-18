import type Anthropic from '@anthropic-ai/sdk';

export const PRODUCT_CONTEXT_AUDIENCES = [
  'customer',
  'admin',
  'standard',
  'unknown',
] as const;

export type ProductContextAudience = (typeof PRODUCT_CONTEXT_AUDIENCES)[number];

export type RouteClaim = {
  route: string;
  purpose: string;
  actions: string[];
  clientRefs: string[];
  serverRefs: string[];
  audience: ProductContextAudience;
  confidence: number;
  evidenceConflicts: string[];
};

export const ROUTE_CLAIM_SCHEMA = {
  type: 'object',
  required: [
    'route',
    'purpose',
    'actions',
    'client_refs',
    'server_refs',
    'audience',
    'confidence',
    'evidence_conflicts',
  ],
  properties: {
    route: { type: 'string' },
    purpose: { type: 'string' },
    actions: { type: 'array', items: { type: 'string' } },
    client_refs: { type: 'array', items: { type: 'string' } },
    server_refs: { type: 'array', items: { type: 'string' } },
    audience: { type: 'string', enum: PRODUCT_CONTEXT_AUDIENCES },
    confidence: {
      type: 'number',
      description: 'How well the code grounds this claim, from 0 (could not ground) to 1 (certain).',
    },
    evidence_conflicts: {
      type: 'array',
      items: { type: 'string' },
      description: 'Evidence you could not reconcile for this route (observed behavior with no code, code contradicting observation). Empty when everything lines up.',
    },
  },
  additionalProperties: false,
} as const;

const CLAIM_KEYS = new Set<string>(ROUTE_CLAIM_SCHEMA.required);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, field: string, index: number): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`Product-context claim ${index} field ${field} must be a string array`);
  }
  return [...new Set(value.map((entry) => entry.trim()).filter(Boolean))];
}

function isAudience(value: unknown): value is ProductContextAudience {
  return typeof value === 'string'
    && (PRODUCT_CONTEXT_AUDIENCES as readonly string[]).includes(value);
}

/** Strict terminal tool used by the read-only repository agent. */
export function routeClaimsTerminalTool(): Anthropic.Tool {
  return {
    name: 'submit_product_context',
    description: 'Submit grounded product understanding for the discovered routes.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        claims: { type: 'array', items: ROUTE_CLAIM_SCHEMA },
      },
      required: ['claims'],
    },
  };
}

/** Validate model output against the exact set of mechanically discovered routes. */
export function parseRouteClaims(raw: unknown, discoveredRoutes: string[]): RouteClaim[] {
  if (!isRecord(raw) || !Array.isArray(raw['claims'])) {
    throw new Error('Product-context submission must be an object with a claims array');
  }
  if (Object.keys(raw).some((key) => key !== 'claims')) {
    throw new Error('Product-context submission contains an unknown field');
  }

  const allowed = new Set(discoveredRoutes);
  const seen = new Set<string>();
  return raw['claims'].map((value, index) => {
    if (!isRecord(value)) throw new Error(`Product-context claim ${index} must be an object`);
    const unknownKey = Object.keys(value).find((key) => !CLAIM_KEYS.has(key));
    if (unknownKey) {
      throw new Error(`Product-context claim ${index} contains unknown field ${unknownKey}`);
    }
    const route = value['route'];
    if (typeof route !== 'string' || !allowed.has(route)) {
      throw new Error(`Product-context claim ${index} contains an undiscovered route`);
    }
    if (seen.has(route)) throw new Error(`Product-context submission repeats route ${route}`);
    seen.add(route);

    const purpose = value['purpose'];
    if (typeof purpose !== 'string' || purpose.trim() === '') {
      throw new Error(`Product-context claim ${index} must have a purpose`);
    }
    const audience = value['audience'];
    if (!isAudience(audience)) {
      throw new Error(`Product-context claim ${index} has an unknown audience`);
    }
    const confidence = value['confidence'];
    if (typeof confidence !== 'number' || !Number.isFinite(confidence)
      || confidence < 0 || confidence > 1) {
      throw new Error(`Product-context claim ${index} confidence must be between 0 and 1`);
    }
    return {
      route,
      purpose: purpose.trim(),
      actions: stringArray(value['actions'], 'actions', index),
      clientRefs: stringArray(value['client_refs'], 'client_refs', index),
      serverRefs: stringArray(value['server_refs'], 'server_refs', index),
      audience,
      confidence,
      evidenceConflicts: stringArray(value['evidence_conflicts'], 'evidence_conflicts', index),
    };
  });
}
