import { computeDebugId } from '@opslane/sdk/build/debug-id';
import type { CachedPosition, PositionKey } from './resolve/position-cache.js';
import type { ResolvedFrameV2 } from './resolve/envelope.js';
import {
  isParseableMap,
  parseStackFrames,
  resolveFrame,
  type ResolvedFrame,
  type StackFrame,
} from './source-map.js';

const MAX_FRAMES = 10;
const DEBUG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type ResolutionStatus =
  | 'resolved'
  | 'partial'
  | 'no_debug_ids'
  | 'map_not_found'
  | 'invalid_map'
  | 'resolution_failed';

export interface StackResolution {
  status: ResolutionStatus;
  frames: ResolvedFrame[] | null;
  identityFrames: ResolvedFrameV2[] | null;
}

export interface SourceMapRow {
  debug_id: string;
  object_key: string;
  content_sha256: string;
}

export interface ResolveDeps {
  getMapRows(projectId: string, debugIds: string[]): Promise<SourceMapRow[]>;
  fetchMap(objectKey: string): Promise<string | null>;
  lookupPosition?(key: PositionKey): Promise<CachedPosition | null>;
  storePosition?(key: PositionKey, value: CachedPosition): Promise<void>;
}

interface DebugImage {
  type: 'sourcemap';
  code_file: string;
  debug_id: string;
}

/** Whether the event references any source map at all — events without debug
 * images never need object storage to settle. */
export function hasDebugImages(debugMeta: string | null): boolean {
  return parseImages(debugMeta).length > 0;
}

function parseImages(debugMeta: string | null): DebugImage[] {
  if (!debugMeta) return [];
  try {
    const parsed = JSON.parse(debugMeta) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return [];
    const images = (parsed as { images?: unknown }).images;
    if (!Array.isArray(images)) return [];
    return images.filter((image): image is DebugImage => {
      if (typeof image !== 'object' || image === null) return false;
      const candidate = image as Record<string, unknown>;
      return candidate['type'] === 'sourcemap'
        && typeof candidate['code_file'] === 'string'
        && typeof candidate['debug_id'] === 'string'
        && DEBUG_ID.test(candidate['debug_id']);
    });
  } catch {
    return [];
  }
}

/**
 * Read frames a previous job stored, in the shape the prompts already use.
 *
 * Accepts both stored shapes: the v2 envelope the stack_resolve job persists
 * in error_event_resolutions, and the legacy v1 envelope older events carry in
 * `stack_trace_resolved`. The prompt builders receive `ResolvedFrame[]`, which
 * gets serialized straight into the model's context, so handing over a raw
 * envelope would put two different schemas under the same "Resolved Stack
 * Trace" heading depending on which row produced it.
 */
export function framesFromEnvelope(stored: unknown): ResolvedFrame[] | null {
  if (typeof stored !== 'object' || stored === null) return null;
  const frames = (stored as { frames?: unknown }).frames;
  if (!Array.isArray(frames)) return null;
  const mapped: ResolvedFrame[] = [];
  for (const frame of frames) {
    if (typeof frame !== 'object' || frame === null) continue;
    const candidate = frame as Record<string, unknown>;
    const file = candidate['original_file'];
    const line = candidate['original_line'];
    // v1 frames carry original_column; v2 identity frames do not (identity
    // never keys on columns), so a missing column reads as 0 rather than
    // dropping the frame.
    const column = candidate['original_column'];
    if (typeof file !== 'string' || typeof line !== 'number') {
      continue;
    }
    const fn = candidate['original_function'];
    const snippet = candidate['source_snippet'];
    mapped.push({
      originalFile: file,
      ...(typeof fn === 'string' && fn !== '' ? { originalFunction: fn } : {}),
      originalLine: line,
      originalColumn: typeof column === 'number' ? column : 0,
      sourceSnippet: typeof snippet === 'string' ? snippet : null,
    });
  }
  return mapped.length > 0 ? mapped : null;
}

export async function resolveEventStack(
  input: { stackTraceRaw: string; debugMeta: string | null; projectId: string },
  deps: ResolveDeps,
): Promise<StackResolution> {
  try {
    const images = parseImages(input.debugMeta);
    if (images.length === 0) {
      return { status: 'no_debug_ids', frames: null, identityFrames: null };
    }

    const byCodeFile = new Map(
      images.map((image) => [image.code_file, image.debug_id]),
    );
    const matched = parseStackFrames(input.stackTraceRaw)
      .map((frame) => ({ frame, debugId: byCodeFile.get(frame.file) }))
      .filter(
        (entry): entry is { frame: StackFrame; debugId: string } =>
          entry.debugId !== undefined,
      )
      .slice(0, MAX_FRAMES);
    if (matched.length === 0) {
      return { status: 'no_debug_ids', frames: null, identityFrames: null };
    }

    const rows = await deps.getMapRows(
      input.projectId,
      [...new Set(matched.map(({ debugId }) => debugId))],
    );
    if (rows.length === 0) {
      return { status: 'map_not_found', frames: null, identityFrames: null };
    }
    const rowByDebugID = new Map(rows.map((row) => [row.debug_id, row]));
    const mapCache = new Map<string, string | null>();
    const resolved: ResolvedFrame[] = [];
    const identityFrames: ResolvedFrameV2[] = [];
    let fetchedAny = false;
    let sawValidMap = false;

    for (const { frame, debugId } of matched) {
      const row = rowByDebugID.get(debugId);
      if (!row) continue;

      const positionKey: PositionKey = {
        projectId: input.projectId,
        debugId,
        mapContentSha: row.content_sha256,
        line: frame.line,
        column: frame.column,
      };
      const cached = await deps.lookupPosition?.(positionKey) ?? null;
      if (cached) {
        resolved.push({
          originalFile: cached.originalFile,
          originalLine: cached.originalLine,
          originalColumn: 0,
          sourceSnippet: null,
        });
        identityFrames.push({
          original_file: cached.originalFile,
          original_function: cached.originalFunction,
          original_line: cached.originalLine,
          generated: { line: frame.line, column: frame.column },
        });
        continue;
      }

      let mapContent = mapCache.get(row.object_key);
      if (mapContent === undefined) {
        // Scoped to the one object. A stack usually spans several chunks, and
        // letting a single unreachable map reach the function-wide catch would
        // discard every frame the other maps could still resolve.
        try {
          mapContent = await deps.fetchMap(row.object_key);
        } catch {
          mapContent = null;
        }
        if (mapContent !== null) {
          fetchedAny = true;
          try {
            const { contentSha256 } = await computeDebugId(
              new TextEncoder().encode(mapContent),
            );
            if (contentSha256 !== row.content_sha256) mapContent = null;
          } catch {
            mapContent = null;
          }
        }
        mapCache.set(row.object_key, mapContent);
      }
      if (mapContent === null) continue;

      const result = resolveFrame(
        { ...frame, column: Math.max(0, frame.column - 1) },
        mapContent,
      );
      if (result) {
        sawValidMap = true;
        resolved.push({
          originalFile: result.originalFile,
          originalLine: result.originalLine,
          originalColumn: result.originalColumn,
          sourceSnippet: result.sourceSnippet,
        });
        const cachedValue: CachedPosition = {
          originalFile: result.originalFile,
          originalFunction: result.originalFunction ?? '',
          originalLine: result.originalLine,
        };
        await deps.storePosition?.(positionKey, cachedValue);
        identityFrames.push({
          original_file: cachedValue.originalFile,
          original_function: cachedValue.originalFunction,
          original_line: cachedValue.originalLine,
          generated: { line: frame.line, column: frame.column },
        });
      } else if (isParseableMap(mapContent)) {
        sawValidMap = true;
      }
    }

    if (resolved.length === matched.length) {
      return { status: 'resolved', frames: resolved, identityFrames };
    }
    if (resolved.length > 0) {
      return { status: 'partial', frames: resolved, identityFrames };
    }
    if (fetchedAny && !sawValidMap) {
      return { status: 'invalid_map', frames: null, identityFrames: null };
    }
    return { status: 'resolution_failed', frames: null, identityFrames: null };
  } catch {
    return { status: 'resolution_failed', frames: null, identityFrames: null };
  }
}
