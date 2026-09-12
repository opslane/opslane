import { describe, it, expect } from 'vitest';
import { stampCodeAndMap, unstamp, DEBUG_ID_TRAILER, stripSourceMappingURLDirectives, getSourceMappingURL } from '../build/stamp';

const code = 'console.log("hi");\n//# sourceMappingURL=app.js.map\n';
const map = JSON.stringify({ version: 3, file: 'app.js', sources: ['../src/app.ts'], names: [], mappings: 'AAAA' });
const base = { code, mapSource: map, mapFileName: 'app.js.map', projectRoot: '/repo', outDir: '/repo/dist', maxMapBytes: 32 << 20 };

describe('stampCodeAndMap', () => {
  it('stamps a script chunk with a trailer, a prelude, and a debugId in the map', async () => {
    const out = await stampCodeAndMap({ ...base, format: 'iife' });
    expect(out.code.endsWith(`\n//# debugId=${out.debugId}`)).toBe(true);
    expect(out.code).toContain('document.currentScript');
    expect(out.code).toContain(out.debugId);
    expect(JSON.parse(out.mapSource).debugId).toBe(out.debugId);
    expect(out.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(DEBUG_ID_TRAILER.test(out.code)).toBe(true);
  });
  it('is deterministic and unstamps cleanly for es output', async () => {
    const a = await stampCodeAndMap({ ...base, format: 'es' });
    const b = await stampCodeAndMap({ ...base, format: 'es' });
    expect(a.debugId).toBe(b.debugId);
    expect(unstamp(a.code, a.debugId, 'es')?.code).toBe(code);
  });
  it('refuses an unsupported format', async () => {
    await expect(stampCodeAndMap({ ...base, format: 'amd' })).rejects.toThrow('unsupported output format');
  });
  it('flattens an indexed (sectioned) map before stamping', async () => {
    const indexed = JSON.stringify({
      version: 3, file: 'app.js',
      sections: [
        { offset: { line: 0, column: 0 }, map: { version: 3, sources: ['../src/a.ts'], names: [], mappings: 'AAAA' } },
        { offset: { line: 1, column: 0 }, map: { version: 3, sources: ['../src/b.ts'], names: [], mappings: 'AAAA' } },
      ],
    });
    const out = await stampCodeAndMap({ ...base, mapSource: indexed, code: 'a();\nb();\n//# sourceMappingURL=app.js.map\n', format: 'iife' });
    const flat = JSON.parse(out.mapSource);
    expect(flat.sections).toBeUndefined();
    expect(flat.sources).toEqual(expect.arrayContaining([expect.stringContaining('a.ts'), expect.stringContaining('b.ts')]));
    expect(flat.debugId).toBe(out.debugId);
  });
});

describe('indexed map validation and resolution', () => {
  it('preserves section offsets, names, and embedded source text after inserting the prelude', async () => {
    const { TraceMap, originalPositionFor } = await import('@jridgewell/trace-mapping');
    const source = (name: string, text: string) => ({ version: 3, sources: [`../src/${name}.ts`], sourcesContent: [text], names: [name], mappings: 'AAAAA' });
    const out = await stampCodeAndMap({ ...base, code: 'a();\n\n   b();', format: 'iife', mapSource: JSON.stringify({
      version: 3, sections: [
        { offset: { line: 0, column: 0 }, map: source('a', 'a();') },
        { offset: { line: 2, column: 3 }, map: source('b', 'b();') },
      ],
    }) });
    const parsed = JSON.parse(out.mapSource);
    const trace = new TraceMap(parsed);
    expect(originalPositionFor(trace, { line: 2, column: 0 })).toMatchObject({ source: 'src/a.ts', line: 1, column: 0, name: 'a' });
    expect(originalPositionFor(trace, { line: 4, column: 3 })).toMatchObject({ source: 'src/b.ts', line: 1, column: 0, name: 'b' });
    expect(parsed.sourcesContent).toEqual(['a();', 'b();']);
  });

  it('rejects duplicate JSON fields even inside an indexed section', async () => {
    const section = '{"version":3,"sources":["a"],"names":[],"mappings":"AAAA","mappings":"BBBB"}';
    await expect(stampCodeAndMap({ ...base, format: 'es', mapSource: `{"version":3,"sections":[{"offset":{"line":0,"column":0},"map":${section}}]}` })).rejects.toThrow('duplicate_key');
  });

  it('refuses external indexed sections and unordered offsets', async () => {
    for (const sections of [
      [{ offset: { line: 0, column: 0 }, url: 'external.map' }],
      [{ offset: { line: 1, column: 0 }, map: JSON.parse(map) }, { offset: { line: 0, column: 0 }, map: JSON.parse(map) }],
    ]) {
      await expect(stampCodeAndMap({ ...base, format: 'es', mapSource: JSON.stringify({ version: 3, sections }) })).rejects.toThrow('indexed source map');
    }
  });

  it('checks the raw byte size before parsing', async () => {
    await expect(stampCodeAndMap({ ...base, format: 'es', maxMapBytes: 1 })).rejects.toThrow('over the limit');
  });
});


describe('source-map directive comments', () => {
  it('strips inline comments while preserving every generated position', () => {
    const code = 'run(); //# sourceMappingURL=../maps/chunk.map\r\n' +
      'a(); /*# sourceMappingURL=other.map */ b();\n';
    const stripped = stripSourceMappingURLDirectives(code);
    expect(stripped).not.toContain('sourceMappingURL');
    expect(stripped.length).toBe(code.length);
    expect(stripped.indexOf('b();')).toBe(code.indexOf('b();'));
    expect(stripped.indexOf('\r\n')).toBe(code.indexOf('\r\n'));
    expect(stripped).toContain('run();');
  });

  it('preserves directive lookalikes inside strings, multiline templates, and regex literals', () => {
    const code = [
      'const a = "//# sourceMappingURL=string.map";',
      "const b = '/*# sourceMappingURL=string.map */';",
      'const c = `template',
      '//# sourceMappingURL=template.map',
      '/*# sourceMappingURL=template-block.map */',
      '`;',
      String.raw`const d = /\/\/# sourceMappingURL=regex.map/;`,
      String.raw`const e = /[/*]# sourceMappingURL=regex-class.map/;`,
    ].join('\n');
    expect(stripSourceMappingURLDirectives(code)).toBe(code);
  });

  it('falls back to the trailing directive when the chunk cannot be lexed', () => {
    // A lone `}` is a syntax error for the tokenizer; the directive must still be found and stripped.
    const code = '}\nvar a = 1;\n//# sourceMappingURL=main.js.map\n';
    expect(getSourceMappingURL(code)).toBe('main.js.map');
    const stripped = stripSourceMappingURLDirectives(code);
    expect(stripped).not.toContain('sourceMappingURL');
    expect(stripped.split('\n').length).toBe(code.split('\n').length);
  });
});
