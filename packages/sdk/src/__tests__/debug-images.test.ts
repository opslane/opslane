import { afterEach, describe, expect, it } from 'vitest';
import { assembleDebugMeta } from '../debug-images.js';
import { REGISTRY_GLOBAL } from '../build/registry-contract.js';

const DEBUG_ID = '01234567-89ab-cdef-0123-456789abcdef';
const OTHER_DEBUG_ID = 'fedcba98-7654-3210-fedc-ba9876543210';

function setRegistry(registry: Record<string, string[]>): void {
  Object.assign(globalThis, { [REGISTRY_GLOBAL]: registry });
}

describe('assembleDebugMeta', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[REGISTRY_GLOBAL];
  });

  it('matches a named V8 frame by exact chunk URL', () => {
    const codeFile = 'https://h/assets/i.js';
    setRegistry({ [codeFile]: [DEBUG_ID] });

    expect(
      assembleDebugMeta(`Error: boom\n    at fn (${codeFile}:1:2)`),
    ).toEqual({
      images: [{ type: 'sourcemap', code_file: codeFile, debug_id: DEBUG_ID }],
    });
  });

  it.each([
    ['V8 anonymous', `    at https://h/assets/i.js:1:2`],
    ['V8 named', `    at fn (https://h/assets/i.js:1:2)`],
    ['Firefox', `fn@https://h/assets/i.js:1:2`],
    ['Firefox anonymous', `@https://h/assets/i.js:1:2`],
    ['WebKit named', `fn@https://h/assets/i.js:1:2`],
    ['WebKit global', `global code@https://h/assets/i.js:1:2`],
    [
      'eval-wrapped V8',
      `    at eval (eval at fn (https://h/assets/i.js:1:2))`,
    ],
  ])('matches a real %s stack shape', (_name, frame) => {
    const codeFile = 'https://h/assets/i.js';
    setRegistry({ [codeFile]: [DEBUG_ID] });

    expect(assembleDebugMeta(`Error: boom\n${frame}`)?.images).toEqual([
      { type: 'sourcemap', code_file: codeFile, debug_id: DEBUG_ID },
    ]);
  });

  it('skips unparseable and unmatched frames without guessing', () => {
    setRegistry({ 'https://h/assets/i.js': [DEBUG_ID] });

    expect(
      assembleDebugMeta(
        'Error: boom\n    at fn (<anonymous>)\nthirdParty@https://other/x.js:1:2',
      ),
    ).toEqual({ images: [] });
  });

  it('stops before synthetic caller frames', () => {
    const codeFile = 'https://h/assets/sdk.js';
    setRegistry({ [codeFile]: [DEBUG_ID] });

    expect(
      assembleDebugMeta(
        [
          'SyntaxError: bad input',
          '    --- synthetic caller stack ---',
          `    at capture (${codeFile}:1:2)`,
        ].join('\n'),
      ),
    ).toEqual({ images: [] });
  });

  it('keeps captured stack order and collapses exact duplicates', () => {
    const first = 'https://h/assets/first.js';
    const second = 'https://h/assets/second.js';
    setRegistry({ [first]: [DEBUG_ID], [second]: [OTHER_DEBUG_ID] });

    expect(
      assembleDebugMeta(
        [
          'Error: boom',
          `    at second (${second}:1:2)`,
          `    at first (${first}:3:4)`,
          `    at secondAgain (${second}:5:6)`,
        ].join('\n'),
      )?.images,
    ).toEqual([
      { type: 'sourcemap', code_file: second, debug_id: OTHER_DEBUG_ID },
      { type: 'sourcemap', code_file: first, debug_id: DEBUG_ID },
    ]);
  });

  it('discards both IDs when a conflict appears at candidate 65', () => {
    const registry: Record<string, string[]> = {};
    const frames = ['Error: boom'];
    for (let index = 0; index < 63; index++) {
      const codeFile = `https://h/assets/${index}.js`;
      registry[codeFile] = [DEBUG_ID];
      frames.push(`    at f${index} (${codeFile}:1:2)`);
    }
    const conflict = 'https://h/assets/conflict.js';
    registry[conflict] = [DEBUG_ID, OTHER_DEBUG_ID];
    frames.push(`    at conflict (${conflict}:1:2)`);
    setRegistry(registry);

    const images = assembleDebugMeta(frames.join('\n'))?.images;

    expect(images).toHaveLength(63);
    expect(images).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code_file: conflict })]),
    );
  });

  it('accepts a 4096-byte code_file and rejects longer or controlled values', () => {
    const prefix = 'https://h/';
    const maximal = prefix + 'a'.repeat(4096 - prefix.length);
    const tooLong = `${maximal}a`;
    const controlled = 'https://h/a\u0000.js';
    setRegistry({
      [maximal]: [DEBUG_ID],
      [tooLong]: [DEBUG_ID],
      [controlled]: [DEBUG_ID],
    });

    expect(
      assembleDebugMeta(
        [
          'Error: boom',
          `    at max (${maximal}:1:2)`,
          `    at long (${tooLong}:1:2)`,
          `    at bad (${controlled}:1:2)`,
        ].join('\n'),
      )?.images,
    ).toEqual([
      { type: 'sourcemap', code_file: maximal, debug_id: DEBUG_ID },
    ]);
  });

  it('drops images from the tail until debug_meta fits 16 KiB', () => {
    const registry: Record<string, string[]> = {};
    const frames = ['Error: boom'];
    for (let index = 0; index < 10; index++) {
      const codeFile = `https://h/${index}/` + 'a'.repeat(3000);
      registry[codeFile] = [DEBUG_ID];
      frames.push(`    at f${index} (${codeFile}:1:2)`);
    }
    setRegistry(registry);

    const meta = assembleDebugMeta(frames.join('\n'));

    expect(meta?.images?.length).toBeGreaterThan(0);
    expect(meta?.images?.length).toBeLessThan(10);
    expect(new TextEncoder().encode(JSON.stringify(meta)).byteLength).toBeLessThanOrEqual(
      16 * 1024,
    );
  });

  it('distinguishes no registry from a populated registry with zero matches', () => {
    expect(assembleDebugMeta('Error: boom')).toBeUndefined();
    setRegistry({});
    expect(assembleDebugMeta('Error: boom')).toBeUndefined();
    setRegistry({ 'https://h/assets/i.js': [DEBUG_ID] });
    expect(assembleDebugMeta('Error: boom')).toEqual({ images: [] });
  });

  it('uses exact URL identity without stripping query strings', () => {
    setRegistry({ 'https://h/assets/i.js?v=1': [DEBUG_ID] });

    expect(
      assembleDebugMeta('Error: boom\n    at fn (https://h/assets/i.js:1:2)'),
    ).toEqual({ images: [] });
  });

  it('ignores malformed registry entries', () => {
    setRegistry({
      'https://h/assets/good.js': [DEBUG_ID],
      'https://h/assets/bad.js': ['NOT-A-DEBUG-ID'],
    });

    expect(
      assembleDebugMeta(
        'Error: boom\n    at bad (https://h/assets/bad.js:1:2)',
      ),
    ).toEqual({ images: [] });
  });
});
