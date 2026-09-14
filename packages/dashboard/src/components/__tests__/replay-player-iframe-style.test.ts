import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compileStyle, parse } from 'vue/compiler-sfc';
import { describe, expect, it } from 'vitest';

const FILENAME = fileURLToPath(new URL('../ReplayPlayer.vue', import.meta.url));
const SCOPE_ID = 'data-v-replay';

function compiledStyles(): string {
  const { descriptor, errors } = parse(readFileSync(FILENAME, 'utf8'), { filename: FILENAME });
  expect(errors).toEqual([]);
  return descriptor.styles
    .map((style) => {
      const result = compileStyle({ source: style.content, filename: FILENAME, id: SCOPE_ID, scoped: style.scoped });
      expect(result.errors).toEqual([]);
      return result.code;
    })
    .join('\n');
}

function declarationsFor(css: string, selector: string): string[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const declarations: string[] = [];
  for (const rule of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = rule[1].split(',').map((part) => part.trim());
    if (!selectors.includes(selector)) continue;
    for (const declaration of rule[2].split(';')) {
      const normalized = declaration.trim().replace(/\s*:\s*/, ': ');
      if (normalized) declarations.push(normalized);
    }
  }
  return declarations;
}

/**
 * rrweb sizes the replay iframe with width/height attributes set to the recorded
 * viewport, and ReplayPlayer fits it by scaling `.replayer-wrapper`. The
 * dashboard's base reset (`iframe { max-width: 100% }`) would cap the iframe at
 * the container width instead, so the replayed app reflows to a narrower layout
 * and its recorded scroll positions stop applying (#495). The computed result is
 * pinned in a real browser by the "session replay viewport in Chromium" e2e suite.
 */
describe('ReplayPlayer iframe style', () => {
  it('lifts the global max-width cap off the rrweb iframe', () => {
    const maxWidths = declarationsFor(compiledStyles(), `.replay-container[${SCOPE_ID}] iframe`)
      .filter((declaration) => declaration.startsWith('max-width:'));
    expect(maxWidths.length).toBeGreaterThan(0);
    expect(maxWidths[maxWidths.length - 1]).toBe('max-width: none');
  });
});
