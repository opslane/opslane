export const RESOLVER_VERSION = 2;

export interface GeneratedPos {
  line: number;
  column: number;
}

export interface ResolvedFrame {
  original_file: string;
  original_function: string;
  original_line: number;
  generated: GeneratedPos;
}

export interface EnvelopeV2 {
  version: 2;
  frames: ResolvedFrame[];
}

export function buildEnvelope(frames: ResolvedFrame[]): EnvelopeV2 {
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
