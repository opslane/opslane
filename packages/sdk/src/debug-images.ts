import type { DebugImage, DebugMeta } from '@opslane/shared';
import {
  REGISTRY_GLOBAL,
  type DebugIdRegistry,
} from './build/registry-contract.js';

const DEBUG_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SYNTHETIC_STACK_MARKER = '--- synthetic caller stack ---';
const MAX_IMAGES = 64;
const MAX_DEBUG_META_BYTES = 16 * 1024;
const encoder = new TextEncoder();

/**
 * Match the captured stack to the build registry without normalizing either
 * side. An empty registry omits debug_meta; a populated registry with no exact
 * matches returns an explicit empty image list for field-health metrics.
 */
export function assembleDebugMeta(stack: string): DebugMeta | undefined {
  try {
    const registry = readRegistry();
    if (!registry) return undefined;
    const registryKeys = Object.keys(registry);
    if (registryKeys.length === 0) return undefined;

    const validEntries = registryKeys.flatMap((codeFile) => {
      if (!validCodeFile(codeFile)) return [];
      const ids = registry[codeFile];
      if (!Array.isArray(ids)) return [];
      return ids
        .filter((debugId): debugId is string => DEBUG_ID.test(debugId))
        .map((debugId) => ({ codeFile, debugId }));
    });
    const candidates: DebugImage[] = [];
    for (const line of stack.split('\n')) {
      if (line.includes(SYNTHETIC_STACK_MARKER)) break;
      const codeFile = innermostMatchedFile(
        line,
        validEntries.map((entry) => entry.codeFile),
      );
      if (!codeFile) continue;
      for (const entry of validEntries) {
        if (entry.codeFile !== codeFile) continue;
        candidates.push({
          type: 'sourcemap',
          code_file: codeFile,
          debug_id: entry.debugId,
        });
      }
    }

    const unique: DebugImage[] = [];
    const pairs = new Set<string>();
    for (const image of candidates) {
      const pair = `${image.code_file}\0${image.debug_id}`;
      if (pairs.has(pair)) continue;
      pairs.add(pair);
      unique.push(image);
    }

    const idsByFile = new Map<string, Set<string>>();
    for (const image of unique) {
      const ids = idsByFile.get(image.code_file) ?? new Set<string>();
      ids.add(image.debug_id);
      idsByFile.set(image.code_file, ids);
    }
    const images = unique
      .filter((image) => idsByFile.get(image.code_file)?.size === 1)
      .slice(0, MAX_IMAGES);

    while (
      images.length > 0 &&
      encoder.encode(JSON.stringify({ images })).byteLength >
        MAX_DEBUG_META_BYTES
    ) {
      images.pop();
    }
    return { images };
  } catch {
    return undefined;
  }
}

function readRegistry(): DebugIdRegistry | undefined {
  const value = (globalThis as Record<string, unknown>)[REGISTRY_GLOBAL];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as DebugIdRegistry;
}

function validCodeFile(codeFile: string): boolean {
  const byteLength = encoder.encode(codeFile).byteLength;
  return (
    byteLength >= 1 &&
    byteLength <= 4096 &&
    !/[\u0000-\u001f\u007f]/.test(codeFile)
  );
}

function innermostMatchedFile(
  line: string,
  codeFiles: string[],
): string | undefined {
  let selected: string | undefined;
  let selectedOffset = -1;
  for (const codeFile of codeFiles) {
    let from = 0;
    while (from < line.length) {
      const offset = line.indexOf(codeFile, from);
      if (offset === -1) break;
      const suffix = line.slice(offset + codeFile.length);
      if (/^:\d+:\d+(?:\D|$)/.test(suffix) && offset >= selectedOffset) {
        selected = codeFile;
        selectedOffset = offset;
      }
      from = offset + codeFile.length;
    }
  }
  return selected;
}
