import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return entry === '__tests__' ? [] : sources(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

const files = sources(SRC).map((file) => ({ path: relative(SRC, file).split('\\').join('/'), text: readFileSync(file, 'utf8') }));

function callsMessagesCreate(source: string): boolean {
  const ast = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true);
  const property = (node: ts.Node): string | undefined => {
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) return node.argumentExpression.text;
    return undefined;
  };
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && property(node.expression) === 'create'
      && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))
      && property(node.expression.expression) === 'messages') found = true;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return found;
}

function constructsAnthropic(source: string): boolean {
  const ast = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && node.expression.getText(ast) === 'Anthropic') found = true;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return found;
}

function offenders(pattern: RegExp, allowed: string[]): string[] {
  return files.filter((file) => pattern.test(file.text) && !allowed.includes(file.path)).map((file) => file.path);
}

describe('model gateway guard', () => {
  it('detects constructors while ignoring examples in comments', () => {
    expect(constructsAnthropic('/* new Anthropic() */')).toBe(false);
    expect(constructsAnthropic('const client = new Anthropic ({ apiKey: "k" });')).toBe(true);
  });
  it('catches direct provider calls across formatting and literal property access', () => {
    for (const source of ['client.messages.create({})', 'client.messages\n .create ({})', "client['messages']['create']({})"]) {
      expect(callsMessagesCreate(source)).toBe(true);
    }
    expect(callsMessagesCreate('// client.messages.create({})')).toBe(false);
  });

  it('only the gateways call messages.create', () => {
    expect(files.filter((file) => callsMessagesCreate(file.text) && !['run-logs/logged-messages.ts', 'narrative/client.ts'].includes(file.path)).map((file) => file.path)).toEqual([]);
  });

  it('only the client factory and NarrativeClient construct an Anthropic client', () => {
    expect(files.filter((file) => constructsAnthropic(file.text) && !['anthropic-client.ts', 'narrative/client.ts'].includes(file.path)).map((file) => file.path)).toEqual([]);
    expect(offenders(/^import Anthropic\b/m, ['anthropic-client.ts', 'narrative/client.ts'])).toEqual([]);
  });

  it('only the raw Messages gateway and the agent loop import the client factory', () => {
    const importsFactory = /(?:from\s*|import\s*\(\s*)['"](?:\.{1,2}\/)+(?:[\w-]+\/)*anthropic-client(?:\.js)?['"]/;
    expect(importsFactory.test("import { createAnthropicClient } from '../anthropic-client.js';")).toBe(true);
    expect(importsFactory.test("const factory = await import('./anthropic-client.js');")).toBe(true);
    expect(importsFactory.test("export { createAnthropicClient } from './anthropic-client.js';")).toBe(true);
    expect(offenders(importsFactory, ['run-logs/logged-messages.ts', 'harness/agent-loop.ts'])).toEqual([]);
  });

  it('only the SDK runner imports the Agent SDK, and only the SDK phase helper calls the runner', () => {
    expect(offenders(/from '@anthropic-ai\/claude-agent-sdk'/, ['harness/sdk-agent.ts'])).toEqual([]);
    expect(offenders(/\brunReadOnlyAgentSdk\(/, ['harness/sdk-agent.ts', 'run-logs/sdk-phase.ts'])).toEqual([]);
  });

  it('only the agent loop builds a model port, and it wraps the port in the run log decorator', () => {
    expect(offenders(/\bcreateAnthropicModelPort\(/, ['harness/agent-loop.ts'])).toEqual([]);
    expect(offenders(/\bimplements ModelPort\b|\):\s*ModelPort\s*\{/, ['run-logs/logged-model-port.ts'])).toEqual([]);
    const loop = files.find((file) => file.path === 'harness/agent-loop.ts')!;
    expect(loop.text).toMatch(/loggedModelPort\(createAnthropicModelPort\(/);
  });

  it('bypassing a run log is explicit and rare', () => {
    expect(offenders(/\brun:\s*null\b/, [])).toEqual([]);
    expect(offenders(/\bNOOP_RUN\b/, [
      'run-logs/handle.ts',
      'harness/sdk-agent.ts',
      'harness/agent-loop.ts',
      'friction/confirm-job.ts',
    ])).toEqual([]);
  });
});
