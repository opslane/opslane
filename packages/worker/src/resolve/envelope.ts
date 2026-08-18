// The v2 resolved-frame envelope: the cross-language identity contract.
// Go (packages/ingestion/identity) alone canonicalizes and hashes envelopes;
// this module is the only writer shape. The stack_resolve job persists this
// shape; Go consumes it later when observation identity settles.
export const RESOLVER_VERSION = 2;

export interface GeneratedPos {
  line: number;
  column: number;
}

// Named V2 to avoid colliding with the v1 ResolvedFrame in source-map.ts,
// which uses camelCase fields and carries source snippets.
export interface ResolvedFrameV2 {
  original_file: string;
  original_function: string;
  original_line: number;
  generated: GeneratedPos;
}

export interface EnvelopeV2 {
  version: 2;
  frames: ResolvedFrameV2[];
}

export function buildEnvelope(frames: ResolvedFrameV2[]): EnvelopeV2 {
  return {
    version: RESOLVER_VERSION,
    frames: frames.map((frame) => ({
      original_file: frame.original_file.replace(/\\/g, '/'),
      original_function: frame.original_function || '<anonymous>',
      original_line: frame.original_line,
      generated: {
        line: frame.generated.line,
        column: frame.generated.column,
      },
    })),
  };
}
