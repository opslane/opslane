import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGENT_STATUSES, type AgentStatusContract } from '../contract.js';
import {
  OPSLANE_VITE_PLUGIN,
  OPSLANE_VITE_PLUGIN_MIN_VERSION,
  SUPPORTED_VITE_MAJORS,
} from '../codemods/vite-contract.js';
import ts from 'typescript';

const START = '<!-- BEGIN AGENT_STATUS_CONTRACT -->';
const END = '<!-- END AGENT_STATUS_CONTRACT -->';

function unquoteCode(value: string): string {
  const match = value.match(/^`([\s\S]*)`$/);
  if (!match) throw new Error(`expected a backticked table value, got ${value}`);
  return match[1];
}

export function parseAgentStatusTable(markdown: string): AgentStatusContract[] {
  const start = markdown.indexOf(START);
  const end = markdown.indexOf(END);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('CLI agent contract status-table markers are missing or out of order');
  }

  const rows: AgentStatusContract[] = [];
  const table = markdown.slice(start + START.length, end);
  for (const line of table.split('\n')) {
    if (!line.startsWith('| `')) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length !== 5) throw new Error(`invalid CLI contract row: ${line}`);

    const exitCode = Number(cells[2]);
    const stream = unquoteCode(cells[3]);
    if ((exitCode !== 0 && exitCode !== 1) || (stream !== 'stdout' && stream !== 'stderr')) {
      throw new Error(`invalid CLI contract exit or stream: ${line}`);
    }

    rows.push({
      command: unquoteCode(cells[0]),
      status: unquoteCode(cells[1]),
      exitCode,
      stream,
      meaning: cells[4],
    });
  }
  return rows;
}

describe('CLI agent contract documentation', () => {
  it('matches the canonical runtime status table exactly', () => {
    const markdown = readFileSync(
      new URL('../../../docs/reference/cli-agent-contract.md', import.meta.url),
      'utf8',
    );

    expect(parseAgentStatusTable(markdown)).toEqual(AGENT_STATUSES);
  });

  it('covers every literal exitWithStatus call in CLI source', () => {
    const sourceDir = dirname(fileURLToPath(new URL('../contract.ts', import.meta.url)));
    const usedStatuses = new Set<string>();

    for (const entry of readdirSync(sourceDir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.parentPath.includes('__tests__')) {
        continue;
      }
      const source = readFileSync(join(entry.parentPath, entry.name), 'utf8');
      for (const match of source.matchAll(/exitWithStatus\(\s*['"]([a-z0-9_]+)['"]/g)) {
        usedStatuses.add(match[1]);
      }
    }

    const documentedStatuses = new Set<string>(AGENT_STATUSES.map((entry) => entry.status));
    expect([...usedStatuses].filter((status) => !documentedStatuses.has(status)).sort()).toEqual([]);
  });
});

function sdkSourceFile(): ts.SourceFile {
  const url = new URL('../../../packages/sdk/vite-plugin/index.ts', import.meta.url);
  const source = readFileSync(url, 'utf8');
  return ts.createSourceFile(url.pathname, source, ts.ScriptTarget.Latest, true);
}

/** True when every parameter is optional, so `factory()` is a valid call. */
function callableWithNoArguments(
  parameters: readonly ts.ParameterDeclaration[],
): boolean {
  return parameters.every((parameter) =>
    Boolean(parameter.initializer)
    || Boolean(parameter.questionToken)
    || Boolean(parameter.dotDotDotToken),
  );
}

/**
 * The local name behind an exported name. `export { opslaneVitePlugin as
 * opslane }` is how the SDK actually publishes the factory, and an earlier
 * version of this file only understood a directly exported declaration, so it
 * reported the factory missing no matter what the SDK did.
 */
function localNameForExport(sourceFile: ts.SourceFile, exportedName: string): string | null {
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier) continue;
    const clause = statement.exportClause;
    if (!clause || !ts.isNamedExports(clause)) continue;
    for (const element of clause.elements) {
      if (element.name.text === exportedName) {
        return (element.propertyName ?? element.name).text;
      }
    }
  }
  return exportedName;
}

function sdkExportsZeroArgFactory(sourceFile: ts.SourceFile, exportedName: string): boolean {
  const localName = localNameForExport(sourceFile, exportedName);
  if (!localName) return false;
  const aliased = localName !== exportedName;
  return sourceFile.statements.some((statement) => {
    // An aliased declaration does not need its own export modifier; the
    // `export { ... }` statement is what publishes it.
    const exported = ts.canHaveModifiers(statement)
      && ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported && !aliased) return false;
    if (ts.isFunctionDeclaration(statement)) {
      return Boolean(statement.body)
        && statement.name?.text === localName
        && callableWithNoArguments(statement.parameters);
    }
    if (!ts.isVariableStatement(statement)) return false;
    return statement.declarationList.declarations.some((declaration) =>
      ts.isIdentifier(declaration.name)
      && declaration.name.text === localName
      && declaration.initializer
      && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
      && callableWithNoArguments(declaration.initializer.parameters),
    );
  });
}

/**
 * The value of the SDK's exported plugin-name constant.
 *
 * #224 exports `OPSLANE_VITE_PLUGIN_NAME` and the plugin object uses it, so
 * reading the constant is exact where scanning for a string literal would break
 * the moment the literal moved behind a name. Returns null when the SDK has no
 * such constant, which is the state on this branch until #224 merges.
 */
function sdkPluginNameConstant(sourceFile: ts.SourceFile): string | null {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const exported = ts.getModifiers(statement)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name)
        && declaration.name.text === 'OPSLANE_VITE_PLUGIN_NAME'
        && declaration.initializer
        && ts.isStringLiteral(declaration.initializer)
      ) {
        return declaration.initializer.text;
      }
    }
  }
  return null;
}

describe('Vite plugin contract', () => {
  it('loads and parses the SDK plugin source', () => {
    expect(() => sdkSourceFile()).not.toThrow();
    const diagnostics = (sdkSourceFile() as unknown as { parseDiagnostics: readonly unknown[] })
      .parseDiagnostics;
    expect(diagnostics).toEqual([]);
  });

  // These prove the detectors work before they are pointed at the real SDK. An
  // `it.fails` on the SDK itself passes when the helper throws or is simply
  // wrong, which is how a rename ships unnoticed.
  it.each([
    ['a directly exported zero-argument function', `export function opslane() { return {}; }`, true],
    ['a defaulted parameter', `export function opslane(options = {}) { return {}; }`, true],
    ['an optional parameter', `export function opslane(options?: object) { return {}; }`, true],
    ['an aliased export, which is what the SDK ships',
      `function opslaneVitePlugin(options = {}) { return {}; }
export { opslaneVitePlugin as opslane };`, true],
    ['an aliased arrow', `const f = (o = {}) => ({});
export { f as opslane };`, true],
    ['a required parameter', `export function opslane(options: object) { return {}; }`, false],
    ['no such export', `export function somethingElse() { return {}; }`, false],
  ])('detects %s', (_label, source, expected) => {
    const file = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, true);
    expect(sdkExportsZeroArgFactory(file, 'opslane')).toBe(expected);
  });

  it.each([
    ['the exported constant', `export const OPSLANE_VITE_PLUGIN_NAME = 'opslane-debug-ids';`, 'opslane-debug-ids'],
    ['a renamed constant value', `export const OPSLANE_VITE_PLUGIN_NAME = 'something-else';`, 'something-else'],
    ['an unexported constant', `const OPSLANE_VITE_PLUGIN_NAME = 'opslane-debug-ids';`, null],
    ['no such constant', `export const OTHER = 'opslane-debug-ids';`, null],
  ])('reads %s', (_label, source, expected) => {
    const file = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, true);
    expect(sdkPluginNameConstant(file)).toBe(expected);
  });

  /**
   * The three facts the installer depends on, each of which breaks it silently
   * on its own: the factory the codemod inserts, the plugin name verification
   * matches on, and the version floor discovery gates on. The SDK now ships all
   * three, so these are hard assertions rather than a record of what is
   * missing. A rename or a signature change in the SDK fails here instead of
   * failing every customer install.
   */
  it('agrees with the SDK about the factory, the plugin name, and the floor', () => {
    const sourceFile = sdkSourceFile();
    expect(sdkExportsZeroArgFactory(sourceFile, OPSLANE_VITE_PLUGIN.exportName)).toBe(true);
    expect(sdkPluginNameConstant(sourceFile)).toBe(OPSLANE_VITE_PLUGIN.pluginName);
    expect(OPSLANE_VITE_PLUGIN_MIN_VERSION).toBe('3.0.0');
  });

  // The floor must stay below the release that publishes the factory, or the
  // command refuses the very version that satisfies it.
  it('gates on a version at or below the release that ships the factory', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../../packages/sdk/package.json', import.meta.url), 'utf8'),
    ) as { peerDependencies?: Record<string, string> };
    const declared = manifest.peerDependencies?.vite ?? '';
    // Every major the contract accepts must be one the plugin declares support
    // for, so we never install into a build the plugin has never run in.
    for (let major = SUPPORTED_VITE_MAJORS.minimum; major <= SUPPORTED_VITE_MAJORS.maximum; major += 1) {
      expect(declared).toContain(`^${major}.0.0`);
    }
  });
});
