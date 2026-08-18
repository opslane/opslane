/**
 * Source map resolution using @jridgewell/trace-mapping.
 *
 * Parses stack frames from raw stack traces and resolves them
 * through source maps to original source positions with code snippets.
 */

import { TraceMap, originalPositionFor, sourceContentFor } from '@jridgewell/trace-mapping';

export interface ResolvedFrame {
  originalFile: string;
  originalFunction?: string;
  originalLine: number;
  originalColumn: number;
  sourceSnippet: string | null;
}

export interface StackFrame {
  file: string;
  line: number;
  column: number;
}

/** True when the content constructs a usable TraceMap. */
export function isParseableMap(sourceMapContent: string): boolean {
  try {
    new TraceMap(
      JSON.parse(sourceMapContent) as ConstructorParameters<typeof TraceMap>[0],
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Extracts structured stack frames from a raw stack trace string.
 * Handles V8 formats:
 *   - `at functionName (file:line:column)`
 *   - `at file:line:column`
 */
export function parseStackFrames(rawStack: string): StackFrame[] {
  const frames: StackFrame[] = [];
  // Match "at ... (file:line:col)" or "at file:line:col" (no parens)
  const lineRegex = /at\s+(?:.*?\((.+?):(\d+):(\d+)\)|(.+?):(\d+):(\d+))/g;
  let match: RegExpExecArray | null;
  while ((match = lineRegex.exec(rawStack)) !== null) {
    // Groups 1-3 for parenthesized form, 4-6 for bare form
    const file = match[1] ?? match[4];
    const line = match[2] ?? match[5];
    const column = match[3] ?? match[6];
    if (file && line && column) {
      frames.push({
        file,
        line: parseInt(line, 10),
        column: parseInt(column, 10),
      });
    }
  }
  return frames;
}

/**
 * Resolves a single stack frame through a source map to the original
 * source position. Returns null if resolution fails or position not found.
 */
export function resolveFrame(
  frame: StackFrame,
  sourceMapContent: string,
): ResolvedFrame | null {
  try {
    const rawMap = JSON.parse(sourceMapContent) as unknown;
    const tracer = new TraceMap(rawMap as ConstructorParameters<typeof TraceMap>[0]);
    const pos = originalPositionFor(tracer, {
      line: frame.line,
      column: frame.column,
    });

    if (!pos.source || pos.line === null) return null;

    const content = sourceContentFor(tracer, pos.source);
    let snippet: string | null = null;
    if (content) {
      const lines = content.split('\n');
      const start = Math.max(0, pos.line - 3);
      const end = Math.min(lines.length, pos.line + 2);
      snippet = lines.slice(start, end).join('\n');
    }

    return {
      originalFile: pos.source,
      originalFunction: pos.name ?? '',
      originalLine: pos.line,
      originalColumn: pos.column ?? 0,
      sourceSnippet: snippet,
    };
  } catch {
    return null;
  }
}
