import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGENT_STATUSES, type AgentStatusContract } from '../contract.js';
import { OPSLANE_VITE_PLUGIN } from '../codemods/vite-contract.js';
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

function sdkExportsZeroArgFactory(sourceFile: ts.SourceFile, name: string): boolean {
  return sourceFile.statements.some((statement) => {
    const exported = ts.canHaveModifiers(statement)
      && ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) return false;
    if (ts.isFunctionDeclaration(statement)) {
      return Boolean(statement.body)
        && statement.name?.text === name
        && statement.parameters.length === 0;
    }
    if (!ts.isVariableStatement(statement)) return false;
    return statement.declarationList.declarations.some((declaration) =>
      ts.isIdentifier(declaration.name)
      && declaration.name.text === name
      && declaration.initializer
      && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
      && declaration.initializer.parameters.length === 0,
    );
  });
}

describe('Vite plugin contract', () => {
  it('loads and parses the SDK plugin source', () => {
    expect(() => sdkSourceFile()).not.toThrow();
    const diagnostics = (sdkSourceFile() as unknown as { parseDiagnostics: readonly unknown[] })
      .parseDiagnostics;
    expect(diagnostics).toEqual([]);
  });

  // EXPECTED TO FAIL until #224 ships opslane(). When #224 lands this flips to
  // a hard failure and someone must set OPSLANE_VITE_PLUGIN_MIN_VERSION.
  it.fails('SDK exports the zero-argument plugin factory this CLI inserts', () => {
    expect(sdkExportsZeroArgFactory(sdkSourceFile(), OPSLANE_VITE_PLUGIN.exportName)).toBe(true);
  });
});
