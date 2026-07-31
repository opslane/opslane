import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';

import {
  addOpslanePlugin,
  findPluginList,
  suggestionAtLine,
} from '../codemods/vite-sourcemaps.js';

const locateCases: Array<[string, string, boolean]> = [
  ['plain object', `export default { plugins: [a()] }`, true],
  ['defineConfig', `import {defineConfig} from 'vite'\nexport default defineConfig({ plugins: [a()] })`, true],
  ['arrow returning object', `import {defineConfig} from 'vite'\nexport default defineConfig(() => ({ plugins: [a()] }))`, true],
  ['arrow with a body', `import {defineConfig} from 'vite'\nexport default defineConfig((e) => { return { plugins: [a()] } })`, true],
  ['aliased defineConfig', `import {defineConfig as dc} from 'vite'\nexport default dc({ plugins: [a()] })`, true],
  ['variable config', `const c = { plugins: [a()] }\nexport default c`, true],
  ['no default export', `export const c = { plugins: [] }`, false],
  ['plugins from a call', `export default { plugins: getPlugins() }`, false],
  ['spread in the config', `export default { ...base, plugins: [a()] }`, true],
];

describe('findPluginList', () => {
  it.each(locateCases)('%s', (_name, source, shouldFind) => {
    expect(findPluginList(source, 'vite.config.ts').found !== 'none').toBe(shouldFind);
  });

  it('does not unwrap a local function merely named defineConfig', () => {
    expect(findPluginList(
      `const defineConfig = (x) => x\nexport default defineConfig({ plugins: [] })`,
      'vite.config.ts',
    )).toMatchObject({ found: 'none', reason: 'unsupported_config_shape' });
  });
});

describe('addOpslanePlugin', () => {
  it('inserts into a single-line plugin list at exact offsets', () => {
    const before = `import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
})
`;
    const result = addOpslanePlugin(before, 'vite.config.ts');
    expect(result).toMatchObject({ outcome: 'edited' });
    expect(result.outcome === 'edited' && result.text).toBe(`import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'
import { opslane } from '@opslane/sdk/vite-plugin';
export default defineConfig({
  plugins: [react(),
    opslane()],
})
`);
  });

  it.each(['ts', 'js', 'mjs', 'cjs', 'mts', 'cts'])('supports vite.config.%s', (extension) => {
    const result = addOpslanePlugin('export default { plugins: [] }\n', `vite.config.${extension}`);
    expect(result.outcome).toBe('edited');
    if (result.outcome === 'edited') {
      const again = addOpslanePlugin(result.text, `vite.config.${extension}`);
      expect(again).toEqual({ outcome: 'already_wired', text: result.text });
    }
  });

  it('preserves CRLF, trailing comments, and a byte-order mark', () => {
    const before = "\ufeffimport react from 'react'; // keep\r\nexport default { plugins: [react(),] }\r\n";
    const result = addOpslanePlugin(before, 'vite.config.ts');
    expect(result.outcome).toBe('edited');
    if (result.outcome !== 'edited') return;
    expect(Buffer.from(result.text).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(result.text).toContain("// keep\r\nimport { opslane }");
    expect(result.text).not.toMatch(/(?<!\r)\n/);
  });

  it('handles multiline, typed, and literal-computed plugin lists', () => {
    const cases = [
      `export default { plugins: [\n    a(),\n  ] }`,
      `export default { plugins: [a()] as PluginOption[] }`,
      `export default { plugins: [a()] satisfies PluginOption[] }`,
      `export default { ['plugins']: [a()] }`,
    ];
    for (const source of cases) {
      const result = addOpslanePlugin(source, 'vite.config.ts');
      expect(result.outcome, source).toBe('edited');
      if (result.outcome === 'edited') {
        expect(addOpslanePlugin(result.text, 'vite.config.ts')).toEqual({
          outcome: 'already_wired',
          text: result.text,
        });
      }
    }
  });

  it('suggests a placement for a wrapped list and remains idempotent after confirmation', () => {
    const result = addOpslanePlugin(
      `export default { plugins: [a()].filter(Boolean) }`,
      'vite.config.ts',
    );
    expect(result.outcome).toBe('suggested');
    if (result.outcome === 'suggested') {
      expect(addOpslanePlugin(result.text, 'vite.config.ts')).toEqual({
        outcome: 'already_wired',
        text: result.text,
      });
    }
  });

  it('adds a plugin list last when the config has none', () => {
    const result = addOpslanePlugin(`export default {\n  build: {}\n}\n`, 'vite.config.ts');
    expect(result.outcome).toBe('edited');
    if (result.outcome === 'edited') {
      expect(result.text).toContain(`build: {},\n  plugins: [\n    opslane()\n  ]`);
    }
  });

  it('refuses every unsafe structural shape with a typed reason', () => {
    expect(addOpslanePlugin(`export default { ...base }`, 'vite.config.ts'))
      .toMatchObject({ outcome: 'unsupported', reason: 'plugins_would_be_overwritten' });
    expect(addOpslanePlugin(`const plugins = []\nexport default { plugins }`, 'vite.config.ts'))
      .toMatchObject({ outcome: 'unsupported', reason: 'plugins_shorthand' });
    expect(addOpslanePlugin(`export const config = { plugins: [] }`, 'vite.config.ts'))
      .toMatchObject({ outcome: 'unsupported', reason: 'no_default_export' });
    expect(addOpslanePlugin(
      `export default { plugins: [a()], plugins: [b()] }`,
      'vite.config.ts',
    )).toMatchObject({ outcome: 'unsupported', reason: 'duplicate_plugins_key' });
  });

  it('resolves an aliased plugin binding instead of matching call text', () => {
    const source = `import { opslane as p } from '@opslane/sdk/vite-plugin';\nexport default { plugins: [p()] }\n`;
    expect(addOpslanePlugin(source, 'vite.config.ts')).toEqual({
      outcome: 'already_wired',
      text: source,
    });
  });

  it('reuses the expected imported factory when only registration is missing', () => {
    const source = `import { opslane as p } from '@opslane/sdk/vite-plugin';\nexport default { plugins: [] }\n`;
    const result = addOpslanePlugin(source, 'vite.config.ts');
    expect(result.outcome).toBe('edited');
    if (result.outcome === 'edited') {
      expect(result.text.split('@opslane/sdk/vite-plugin')).toHaveLength(2);
      expect(result.text).toContain('p()');
    }
  });

  it('detects the legacy plugin and installs beside other source-map plugins', () => {
    expect(addOpslanePlugin(
      `import { opslaneSourceMapPlugin } from '@opslane/sdk/vite-plugin'\nexport default { plugins: [] }`,
      'vite.config.ts',
    ).outcome).toBe('legacy_opslane_plugin');
    expect(addOpslanePlugin(
      `import { opslane, opslaneSourceMapPlugin } from '@opslane/sdk/vite-plugin'\nexport default { plugins: [] }`,
      'vite.config.ts',
    ).outcome).toBe('legacy_opslane_plugin');
    // Another vendor's source-map plugin is not a reason to refuse. Design
    // section 6a: the phase order fixes the handover, so we install and, if
    // anything does break, we fix the plugin rather than filter by vendor.
    const sentry = `import { sentryVitePlugin } from '@sentry/vite-plugin'\nexport default { plugins: [] }`;
    expect(addOpslanePlugin(sentry, 'vite.config.ts').outcome).toBe('edited');
    expect(addOpslanePlugin(
      `import { datadogVitePlugin } from '@datadog/vite-plugin'\nexport default { plugins: [] }`,
      'vite.config.ts',
    ).outcome).toBe('edited');
  });

  it('keeps a new import after a multiline trailing comment', () => {
    const source = `import react from 'react'; /* keep\n  this whole comment */\nexport default { plugins: [react()] }\n`;
    const result = addOpslanePlugin(source, 'vite.config.ts');
    expect(result.outcome).toBe('edited');
    if (result.outcome === 'edited') {
      expect(result.text).toContain(
        `/* keep\n  this whole comment */\nimport { opslane } from '@opslane/sdk/vite-plugin';`,
      );
    }
  });

  // A call buried inside an element is not a registration. `enabled && opslane()`
  // registers the plugin only when `enabled` happens to be true, so reporting it
  // as wired tells the customer source maps are on when they may not be. Adding
  // an unconditional sibling is the safe answer, and a second run then sees a
  // direct element and stops.
  it('does not treat a conditional element as a registration', () => {
    const conditional = `import { opslane } from '@opslane/sdk/vite-plugin'\nexport default { plugins: [enabled && opslane()] }`;
    const first = addOpslanePlugin(conditional, 'vite.config.ts');
    expect(first.outcome).toBe('edited');
    expect(addOpslanePlugin(first.text!, 'vite.config.ts').outcome).toBe('already_wired');
  });

  it.each([
    ['a direct element', `export default { plugins: [opslane()] }`],
    ['a direct element behind a cast', `export default { plugins: [opslane() as unknown] }`],
  ])('treats %s as already wired', (_label, body) => {
    const source = `import { opslane } from '@opslane/sdk/vite-plugin'\n${body}`;
    expect(addOpslanePlugin(source, 'vite.config.ts').outcome).toBe('already_wired');
  });

  it('refuses later overwriting spreads', () => {
    const overwritten = `import { opslane } from '@opslane/sdk/vite-plugin'\nexport default { plugins: [opslane()], ...base }`;
    expect(addOpslanePlugin(overwritten, 'vite.config.ts'))
      .toMatchObject({ outcome: 'unsupported', reason: 'plugins_would_be_overwritten' });
  });

  // The import goes to the top of the file, but the call goes wherever the
  // plugin list is. If anything between the two binds the name, the call we
  // insert runs the customer's function instead of ours, and the file still
  // reads as correct. 14 of the 70 measured configs are function shaped.
  it.each([
    ['a const in the callback body', `  const opslane = () => ({ name: 'not-ours' });\n  return { plugins: [] };`],
    ['a let in the callback body', `  let opslane;\n  return { plugins: [] };`],
    ['a function in the callback body', `  function opslane() { return {}; }\n  return { plugins: [] };`],
  ])('refuses when %s shadows the plugin name', (_label, body) => {
    const source = `import { defineConfig } from 'vite';\nexport default defineConfig(() => {\n${body}\n});\n`;
    expect(addOpslanePlugin(source, 'vite.config.ts'))
      .toMatchObject({ outcome: 'unsupported', reason: 'plugin_name_taken' });
  });

  it('refuses when a callback parameter shadows the plugin name', () => {
    const source = `import { defineConfig } from 'vite';\nexport default defineConfig((opslane) => ({ plugins: [] }));\n`;
    expect(addOpslanePlugin(source, 'vite.config.ts'))
      .toMatchObject({ outcome: 'unsupported', reason: 'plugin_name_taken' });
  });

  it('still edits a function config that does not shadow the name', () => {
    const source = `import { defineConfig } from 'vite';\nexport default defineConfig(() => {\n  const react = () => ({});\n  return { plugins: [react()] };\n});\n`;
    expect(addOpslanePlugin(source, 'vite.config.ts').outcome).toBe('edited');
  });

  // `.filter(Boolean)` is safe because our call returns an object. Any other
  // predicate runs after our insertion and can drop us, leaving a config that
  // reads as correct and registers nothing.
  it.each([
    ['a custom predicate', `[a()].filter(p => p.name !== 'opslane-source-map')`],
    ['an index predicate', `[a()].filter((_, i) => i < 1)`],
  ])('refuses a plugin list filtered by %s', (_label, list) => {
    expect(addOpslanePlugin(`export default { plugins: ${list} };`, 'vite.config.ts'))
      .toMatchObject({ outcome: 'unsupported', reason: 'plugins_not_array' });
  });

  it('refuses .filter(Boolean) when Boolean is shadowed', () => {
    const source = `const Boolean = (p) => p.name !== 'opslane-source-map';\n`
      + `export default { plugins: [a()].filter(Boolean) };`;
    expect(addOpslanePlugin(source, 'vite.config.ts'))
      .toMatchObject({ outcome: 'unsupported', reason: 'plugins_not_array' });
  });

  it('still accepts a genuine .filter(Boolean)', () => {
    expect(addOpslanePlugin(`export default { plugins: [a()].filter(Boolean) };`, 'vite.config.ts').outcome)
      .toBe('suggested');
  });

  it('validates moved suggestions structurally', () => {
    const source = `export default {\n  plugins: [\n    react(),\n  ],\n}\n`;
    const moved = suggestionAtLine(source, 'vite.config.ts', 3);
    expect(moved.outcome).toBe('suggested');
    if (moved.outcome === 'suggested') expect(moved.text).toContain('    opslane(),\n    react()');
    expect(suggestionAtLine(source, 'vite.config.ts', 1))
      .toMatchObject({ outcome: 'unsupported', reason: 'unsafe_suggestion' });
    expect(suggestionAtLine(
      `import { sentryVitePlugin } from '@sentry/vite-plugin'\nexport default { plugins: [a()].filter(Boolean) }`,
      'vite.config.ts',
      2,
    ).outcome).toBe('unsupported');
  });
});

/**
 * Inserting the plugin import next to an existing binding of the same name is a
 * redeclaration. TypeScript accepts it as valid grammar, so the parse check and
 * the post-write structural re-read both pass, and only the real Vite load
 * fails. Any `opslane()` already in the plugin list also changes meaning.
 */
describe('addOpslanePlugin with the plugin name already bound', () => {
  const shadows: Array<[string, string]> = [
    ['default import', `import opslane from 'other-pkg';\nexport default { plugins: [opslane()] };\n`],
    ['named import', `import { opslane } from 'other-pkg';\nexport default { plugins: [] };\n`],
    ['namespace import', `import * as opslane from 'other-pkg';\nexport default { plugins: [] };\n`],
    ['const', `const opslane = () => ({});\nexport default { plugins: [] };\n`],
    ['function', `function opslane() { return {}; }\nexport default { plugins: [] };\n`],
    ['destructured const', `const { opslane } = require('x');\nexport default { plugins: [] };\n`],
    ['array destructure', `const [opslane] = [1];\nexport default { plugins: [] };\n`],
    ['renamed import', `import { plugin as opslane } from 'other-pkg';\nexport default { plugins: [] };\n`],
    ['class', `class opslane {}\nexport default { plugins: [] };\n`],
    ['enum', `enum opslane { a }\nexport default { plugins: [] };\n`],
    ['namespace', `namespace opslane {}\nexport default { plugins: [] };\n`],
    ['import equals', `import opslane = require('other-pkg');\nexport default { plugins: [] };\n`],
    ['type alias', `type opslane = string;\nexport default { plugins: [] };\n`],
    ['interface', `interface opslane { a: string }\nexport default { plugins: [] };\n`],
    ['var hoisted from a block', `if (process.env.X) { var opslane = 1; }\nexport default { plugins: [] };\n`],
    ['var hoisted from a loop', `for (var opslane of [1]) {}\nexport default { plugins: [] };\n`],
  ];

  it.each(shadows)('refuses a config that already binds the name via %s', (_label, source) => {
    expect(addOpslanePlugin(source, 'vite.config.ts')).toMatchObject({
      outcome: 'unsupported',
      reason: 'plugin_name_taken',
    });
  });

  it('still edits a config that does not bind the name', () => {
    expect(addOpslanePlugin(`export default { plugins: [] };\n`, 'vite.config.ts').outcome)
      .toBe('edited');
  });

  // `let` and `const` are block scoped, and a `var` inside a function belongs to
  // that function, so none of these can collide with a top-level import.
  const harmless: Array<[string, string]> = [
    ['nested arrow', `export default { plugins: [(() => { const opslane = 1; return null; })()] };\n`],
    ['let in a block', `if (process.env.X) { let opslane = 1; }\nexport default { plugins: [] };\n`],
    ['const in a block', `if (process.env.X) { const opslane = 1; }\nexport default { plugins: [] };\n`],
    ['var inside a function', `function f() { var opslane = 1; }\nexport default { plugins: [] };\n`],
  ];

  it.each(harmless)('still edits when the name is only bound by %s', (_label, source) => {
    expect(addOpslanePlugin(source, 'vite.config.ts').outcome).toBe('edited');
  });

  it('still reports our own registration as already wired', () => {
    const source = `import { opslane } from '@opslane/sdk/vite-plugin';\n`
      + `export default { plugins: [opslane()] };\n`;
    expect(addOpslanePlugin(source, 'vite.config.ts').outcome).toBe('already_wired');
  });
});

/**
 * The SDK publishes one factory under two names. Treating the second as the
 * deprecated uploader would tell a customer already on the current plugin to
 * migrate off it.
 */
describe('addOpslanePlugin against the SDK subpath', () => {
  const spec = '@opslane/sdk/vite-plugin';

  it.each([
    ['opslane', 'opslane'],
    ['opslaneVitePlugin', 'opslaneVitePlugin'],
  ])('treats an existing %s import as the current plugin', (_label, name) => {
    const source = `import { ${name} } from '${spec}';\nexport default { plugins: [] };\n`;
    const result = addOpslanePlugin(source, 'vite.config.ts');
    expect(result.outcome).toBe('edited');
    // The existing local binding is reused rather than importing a second time.
    expect(result.text).toContain(`${name}()`);
    expect(result.text!.match(new RegExp(`from '${spec}'`, 'g'))).toHaveLength(1);
  });

  it.each([
    ['opslane', 'already_wired'],
    ['opslaneVitePlugin', 'already_wired'],
  ])('reports a registered %s as wired', (name, expected) => {
    const source = `import { ${name} } from '${spec}';\nexport default { plugins: [${name}()] };\n`;
    expect(addOpslanePlugin(source, 'vite.config.ts').outcome).toBe(expected);
  });

  it('still refuses the deprecated uploader', () => {
    const source = `import { opslaneSourceMapPlugin } from '${spec}';\n`
      + `export default { plugins: [opslaneSourceMapPlugin({})] };\n`;
    expect(addOpslanePlugin(source, 'vite.config.ts').outcome).toBe('legacy_opslane_plugin');
  });
});
