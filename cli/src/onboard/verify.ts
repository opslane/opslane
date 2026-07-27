import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

import { containedRepoRelative } from './paths.js';
import type { OnboardingPlan } from './tools.js';

const SUPPORTED_ENTRY_EXTENSIONS = new Set([
  '.cjs',
  '.js',
  '.jsx',
  '.mjs',
  '.ts',
  '.tsx',
]);
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_DOTENV_FILES = 64;
const MAX_DOTENV_FILE_BYTES = 64 * 1024;
const MAX_DOTENV_TOTAL_BYTES = 512 * 1024;
const MAX_SCANNED_DIRECTORIES = 10_000;
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules']);
const TRIVIAL_DOTENV_VALUES = new Set([
  '',
  '0',
  '1',
  'false',
  'null',
  'true',
  'undefined',
  'development',
  'local',
  'production',
  'test',
]);
export const OPSLANE_IDENTITY_MIN_VERSION = '2.0.0';

export type VerifiableOnboardingPlan = OnboardingPlan & {
  edit: OnboardingPlan['edit'] & {
    manifest_file: string;
    manifest_hash: string;
  };
};

export interface VerificationResult {
  ok: boolean;
  failures: string[];
}

export interface VerifyAppliedInput {
  root: string;
  plan: VerifiableOnboardingPlan;
  editedFiles: string[];
  originals: {
    entry: Buffer;
    manifest: Buffer;
  };
}

interface ChangedRegion {
  beforeStart: number;
  beforeEnd: number;
  afterStart: number;
  afterEnd: number;
  oldText: string;
  newText: string;
}

interface DotenvValue {
  name: string;
  value: string;
}

interface EntryMatch {
  added: string[];
}

interface SdkBindings {
  initFunctions: Set<string>;
  namespaces: Set<string>;
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

// True only when the buffer is losslessly valid UTF-8. `toString('utf8')` maps
// invalid bytes to U+FFFD, so a round-trip that isn't byte-identical means the
// decode was lossy and a string comparison would not be a faithful byte comparison.
function isValidUtf8(value: Buffer): boolean {
  return Buffer.from(value.toString('utf8'), 'utf8').equals(value);
}

// Drop a single leading UTF-8 BOM so a first-line import still reads as column 0.
// Apply never adds or removes the BOM, so stripping it from both the original and
// the current file for structural checks is consistent.
function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function identityFixedSdkRange(value: string): boolean {
  const normalized = value.trim();
  const match = /^(?:\^|~|>=\s*)?v?(\d+)\.(\d+)\.(\d+)$/.exec(
    normalized,
  );
  if (match === null) return false;
  const [minimumMajor, minimumMinor, minimumPatch] = OPSLANE_IDENTITY_MIN_VERSION.split(
    '.',
  ).map(Number) as [number, number, number];
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return (
    major > minimumMajor ||
    (major === minimumMajor &&
      (minor > minimumMinor || (minor === minimumMinor && patch >= minimumPatch)))
  );
}

function addFailure(failures: string[], message: string): void {
  if (!failures.includes(message)) failures.push(message);
}

function normalizeNewlines(value: string): string {
  return value.replaceAll(/\r\n?|\n/g, '\n');
}

function lineEnding(value: string): '\r\n' | '\n' {
  return value.includes('\r\n') ? '\r\n' : '\n';
}

function countOccurrences(contents: string, needle: string): number[] {
  const matches: number[] = [];
  let offset = 0;
  while (offset <= contents.length - needle.length) {
    const index = contents.indexOf(needle, offset);
    if (index === -1) break;
    matches.push(index);
    offset = index + needle.length;
  }
  return matches;
}

function commonIndent(lines: string[]): number {
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.match(/^[\t ]*/)?.[0].length ?? 0);
  return indents.length === 0 ? 0 : Math.min(...indents);
}

function normalizedBlock(value: string): string[] {
  const lines = normalizeNewlines(value).replace(/\n+$/g, '').split('\n');
  const indent = commonIndent(lines);
  return lines.map((line) => line.slice(Math.min(indent, line.length)));
}

function indentationBefore(contents: string, offset: number): string | null {
  const lineStart = Math.max(contents.lastIndexOf('\n', offset - 1) + 1, 0);
  const prefix = contents.slice(lineStart, offset);
  return /^[\t ]*$/.test(prefix) ? prefix : null;
}

function initCandidates(
  original: string,
  plan: VerifiableOnboardingPlan,
): Array<{ value: string; added: string }> {
  const occurrences = countOccurrences(original, plan.edit.anchor);
  const anchorStart = occurrences[plan.edit.occurrence];
  if (anchorStart === undefined) return [];

  const indent = indentationBefore(original, anchorStart);
  if (indent === null) return [];

  const eol = lineEnding(original);
  const block = normalizedBlock(plan.edit.init_block).join(`${eol}${indent}`);
  const anchorEnd = anchorStart + plan.edit.anchor.length;
  const candidates: Array<{ value: string; added: string }> = [];

  for (const separator of [eol, eol + eol]) {
    if (plan.edit.position === 'before') {
      const added = `${block}${separator}${indent}`;
      candidates.push({
        value: original.slice(0, anchorStart) + added + original.slice(anchorStart),
        added,
      });
    } else {
      const added = `${separator}${indent}${block}`;
      candidates.push({
        value: original.slice(0, anchorEnd) + added + original.slice(anchorEnd),
        added,
      });
    }
  }
  return candidates;
}

function exactEntryMatch(
  original: string,
  current: string,
  plan: VerifiableOnboardingPlan,
): EntryMatch | null {
  const normalizedImport = normalizeNewlines(plan.edit.import_line)
    .replace(/\n+$/g, '')
    .replaceAll('\n', lineEnding(original));
  const importOffsets = countOccurrences(current, normalizedImport);
  const eol = lineEnding(original);

  for (const initCandidate of initCandidates(original, plan)) {
    for (const importOffset of importOffsets) {
      const lineStart = Math.max(current.lastIndexOf('\n', importOffset - 1) + 1, 0);
      if (lineStart !== importOffset) continue;

      for (const suffix of [eol, eol + eol, '']) {
        const addedImport = normalizedImport + suffix;
        if (!current.startsWith(addedImport, importOffset)) continue;
        const withoutImport =
          current.slice(0, importOffset) +
          current.slice(importOffset + addedImport.length);
        if (withoutImport === initCandidate.value) {
          return { added: [addedImport, initCandidate.added] };
        }
      }
    }
  }

  return null;
}

function scriptKind(file: string): ts.ScriptKind {
  switch (path.extname(file).toLowerCase()) {
    case '.ts':
      return ts.ScriptKind.TS;
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    default:
      return ts.ScriptKind.JS;
  }
}

function parseSource(
  file: string,
  contents: string,
): { sourceFile: ts.SourceFile; diagnostics: readonly ts.Diagnostic[] } {
  const sourceFile = ts.createSourceFile(
    file,
    contents,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(file),
  );
  const diagnostics =
    (sourceFile as ts.SourceFile & {
      parseDiagnostics?: readonly ts.Diagnostic[];
    }).parseDiagnostics ?? [];
  return { sourceFile, diagnostics };
}

function sdkBindings(sourceFile: ts.SourceFile): SdkBindings {
  const bindings: SdkBindings = {
    initFunctions: new Set<string>(),
    namespaces: new Set<string>(),
  };

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== '@opslane/sdk'
    ) {
      continue;
    }

    const clause = statement.importClause;
    if (clause?.namedBindings === undefined) continue;
    // `import type { init } ...` is erased at runtime — it cannot initialize the
    // SDK, so it must not satisfy verification or the no_op existence check.
    if (clause.isTypeOnly) continue;
    if (ts.isNamespaceImport(clause.namedBindings)) {
      bindings.namespaces.add(clause.namedBindings.name.text);
      continue;
    }
    for (const specifier of clause.namedBindings.elements) {
      if (specifier.isTypeOnly) continue; // `import { type init }` is also erased
      const imported = specifier.propertyName?.text ?? specifier.name.text;
      if (imported === 'init') bindings.initFunctions.add(specifier.name.text);
      if (imported === 'Opslane' || imported === 'OpslaneSDK') {
        bindings.namespaces.add(specifier.name.text);
      }
    }
  }

  return bindings;
}

function hasBoundInitCall(sourceFile: ts.SourceFile, bindings: SdkBindings): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if (ts.isIdentifier(expression) && bindings.initFunctions.has(expression.text)) {
        found = true;
        return;
      }
      if (
        ts.isPropertyAccessExpression(expression) &&
        expression.name.text === 'init' &&
        ts.isIdentifier(expression.expression) &&
        bindings.namespaces.has(expression.expression.text)
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function boundInitCall(
  sourceFile: ts.SourceFile,
  bindings: SdkBindings,
): ts.CallExpression | null {
  if (sourceFile.statements.length !== 1) return null;
  const statement = sourceFile.statements[0];
  if (statement === undefined || !ts.isExpressionStatement(statement)) return null;
  const expression = statement.expression;
  if (!ts.isCallExpression(expression)) return null;
  if (ts.isIdentifier(expression.expression) && bindings.initFunctions.has(expression.expression.text)) {
    return expression;
  }
  if (
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === 'init' &&
    ts.isIdentifier(expression.expression.expression) &&
    bindings.namespaces.has(expression.expression.expression.text)
  ) {
    return expression;
  }
  return null;
}

function propertyName(node: ts.PropertyName): string | null {
  return ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : null;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return unwrapExpression(expression.expression);
  }
  return expression;
}

function accessSegments(expression: ts.Expression): string[] | null {
  const value = unwrapExpression(expression);
  if (ts.isIdentifier(value)) return [value.text];
  if (
    ts.isMetaProperty(value) &&
    value.keywordToken === ts.SyntaxKind.ImportKeyword &&
    value.name.text === 'meta'
  ) {
    return ['import.meta'];
  }
  if (ts.isPropertyAccessExpression(value)) {
    const base = accessSegments(value.expression);
    return base === null ? null : [...base, value.name.text];
  }
  if (ts.isElementAccessExpression(value)) {
    const base = accessSegments(value.expression);
    if (
      base === null ||
      value.argumentExpression === undefined ||
      !ts.isStringLiteralLike(value.argumentExpression)
    ) {
      return null;
    }
    return [...base, value.argumentExpression.text];
  }
  if (
    ts.isCallExpression(value) &&
    ts.isIdentifier(value.expression) &&
    value.expression.text === 'useRuntimeConfig' &&
    value.arguments.length === 0
  ) {
    return ['useRuntimeConfig()'];
  }
  return null;
}

function isSafeVariableAccess(expression: ts.Expression, variable: string): boolean {
  const segments = accessSegments(expression);
  if (segments === null || segments.at(-1) !== variable) return false;
  return (
    (segments.length === 3 &&
      segments[0] === 'import.meta' &&
      segments[1] === 'env') ||
    (segments.length === 3 && segments[0] === 'process' && segments[1] === 'env') ||
    (segments.length >= 2 && segments[0] === 'useRuntimeConfig()')
  );
}

export function validatePlannedWiring({
  file,
  importLine,
  initBlock,
  apiKeyVariable,
  endpointVariable,
}: {
  file: string;
  importLine: string;
  initBlock: string;
  apiKeyVariable: string;
  endpointVariable: string;
}): string[] {
  const failures: string[] = [];
  const plannedImport = parseSource(file, importLine);
  if (
    plannedImport.diagnostics.length > 0 ||
    plannedImport.sourceFile.statements.length !== 1 ||
    !ts.isImportDeclaration(plannedImport.sourceFile.statements[0])
  ) {
    return ['planned import must be one valid import declaration'];
  }
  const bindings = sdkBindings(plannedImport.sourceFile);
  if (bindings.initFunctions.size === 0 && bindings.namespaces.size === 0) {
    return ['planned import must bind the Opslane initializer'];
  }

  const plannedInit = parseSource(file, initBlock);
  if (plannedInit.diagnostics.length > 0) {
    return ['planned init block has a syntax error'];
  }
  const call = boundInitCall(plannedInit.sourceFile, bindings);
  if (call === null || call.arguments.length !== 1 || !ts.isObjectLiteralExpression(call.arguments[0])) {
    return ['planned init block must be one direct Opslane init call with one object'];
  }

  const properties = new Map<string, ts.Expression>();
  for (const property of call.arguments[0].properties) {
    if (!ts.isPropertyAssignment(property)) {
      failures.push('planned init options must use explicit property assignments');
      continue;
    }
    const name = propertyName(property.name);
    if (name === null || (name !== 'apiKey' && name !== 'endpoint') || properties.has(name)) {
      failures.push('planned init options may contain only one apiKey and one endpoint');
      continue;
    }
    properties.set(name, property.initializer);
  }
  if (properties.size !== 2 || call.arguments[0].properties.length !== 2) {
    failures.push('planned init options must contain exactly apiKey and endpoint');
  }
  const apiKey = properties.get('apiKey');
  if (apiKey === undefined || !isSafeVariableAccess(apiKey, apiKeyVariable)) {
    failures.push(`planned apiKey option must directly reference ${apiKeyVariable}`);
  }
  const endpoint = properties.get('endpoint');
  if (endpoint === undefined || !isSafeVariableAccess(endpoint, endpointVariable)) {
    failures.push(`planned endpoint option must directly reference ${endpointVariable}`);
  }
  return [...new Set(failures)];
}

function hasExactTopLevelImport(
  sourceFile: ts.SourceFile,
  expectedImport: string,
): boolean {
  const expected = normalizeNewlines(expectedImport).trim();
  const matchingIndex = sourceFile.statements.findIndex((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== '@opslane/sdk'
    ) {
      return false;
    }
    const location = sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile));
    return (
      location.character === 0 &&
      normalizeNewlines(statement.getText(sourceFile)).trim() === expected
    );
  });
  if (matchingIndex === -1) return false;

  const otherImportIndices = sourceFile.statements.flatMap((statement, index) =>
    index !== matchingIndex && ts.isImportDeclaration(statement) ? [index] : [],
  );
  if (otherImportIndices.length > 0) {
    const before = sourceFile.statements[matchingIndex - 1];
    const after = sourceFile.statements[matchingIndex + 1];
    return (
      (before !== undefined && ts.isImportDeclaration(before)) ||
      (after !== undefined && ts.isImportDeclaration(after))
    );
  }

  return sourceFile.statements
    .slice(0, matchingIndex)
    .every(
      (statement) =>
        ts.isExpressionStatement(statement) &&
        ts.isStringLiteral(statement.expression),
    );
}

function verifySourceStructure(
  file: string,
  contents: string,
  plan: VerifiableOnboardingPlan,
  failures: string[],
): void {
  const extension = path.extname(file).toLowerCase();
  if (!SUPPORTED_ENTRY_EXTENSIONS.has(extension)) {
    addFailure(failures, `unsupported entry extension: ${extension || '(none)'}`);
    return;
  }
  if (Buffer.byteLength(contents) > MAX_SOURCE_BYTES) {
    addFailure(failures, 'entry file exceeds verification size limit');
    return;
  }

  const parsed = parseSource(file, contents);
  if (parsed.diagnostics.length > 0) {
    addFailure(failures, 'entry file has a syntax error');
    return;
  }
  if (!hasExactTopLevelImport(parsed.sourceFile, plan.edit.import_line)) {
    addFailure(failures, 'planned Opslane import is not in the module top-level import section');
  }

  for (const failure of validatePlannedWiring({
    file,
    importLine: plan.edit.import_line,
    initBlock: plan.edit.init_block,
    apiKeyVariable: plan.env_vars.api_key,
    endpointVariable: plan.env_vars.endpoint,
  })) {
    addFailure(failures, failure);
  }
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqualJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => deepEqualJson(value, right[index]))
    );
  }
  if (!isJsonRecord(left) || !isJsonRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && deepEqualJson(left[key], right[key]),
    )
  );
}

function changedRegion(before: string, after: string): ChangedRegion {
  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix] === after[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const beforeEnd = before.length - suffix;
  const afterEnd = after.length - suffix;
  return {
    beforeStart: prefix,
    beforeEnd,
    afterStart: prefix,
    afterEnd,
    oldText: before.slice(prefix, beforeEnd),
    newText: after.slice(prefix, afterEnd),
  };
}

function jsonPropertyValueRange(
  contents: string,
  propertyPath: string[],
): { start: number; end: number } | null {
  const sourceFile = ts.parseJsonText('package.json', contents);
  const statement = sourceFile.statements[0];
  if (statement === undefined || !ts.isExpressionStatement(statement)) return null;
  let current: ts.Expression = statement.expression;

  for (const segment of propertyPath) {
    if (!ts.isObjectLiteralExpression(current)) return null;
    const property = current.properties.find((candidate) => {
      if (!ts.isPropertyAssignment(candidate)) return false;
      const name = candidate.name;
      return (
        (ts.isStringLiteralLike(name) || ts.isIdentifier(name)) &&
        name.text === segment
      );
    });
    if (property === undefined || !ts.isPropertyAssignment(property)) return null;
    current = property.initializer;
  }

  return { start: current.getStart(sourceFile), end: current.getEnd() };
}

function verifyManifest(
  original: string,
  current: string,
  plan: VerifiableOnboardingPlan,
  failures: string[],
): string[] {
  let originalValue: unknown;
  let currentValue: unknown;
  try {
    originalValue = JSON.parse(original) as unknown;
    currentValue = JSON.parse(current) as unknown;
  } catch {
    addFailure(failures, 'manifest is not valid JSON');
    return [];
  }
  if (!isJsonRecord(originalValue) || !isJsonRecord(currentValue)) {
    addFailure(failures, 'manifest root must be a JSON object');
    return [];
  }

  const originalDependencies = originalValue.dependencies;
  if (
    originalDependencies !== undefined &&
    !isJsonRecord(originalDependencies)
  ) {
    addFailure(failures, 'original manifest dependencies must be an object');
    return [];
  }

  const expected: Record<string, unknown> = {
    ...originalValue,
    dependencies: {
      ...(originalDependencies ?? {}),
      '@opslane/sdk': plan.dependency.version,
    },
  };
  if (!deepEqualJson(currentValue, expected)) {
    addFailure(failures, 'manifest has changes other than the pinned Opslane dependency');
  }

  const region = changedRegion(original, current);
  const previousVersion = isJsonRecord(originalDependencies)
    ? originalDependencies['@opslane/sdk']
    : undefined;
  if (previousVersion === undefined) {
    if (region.oldText.length !== 0) {
      addFailure(failures, 'manifest rewrote existing bytes');
    }
  } else if (previousVersion === plan.dependency.version) {
    if (region.oldText.length !== 0 || region.newText.length !== 0) {
      addFailure(failures, 'manifest changed despite already having the pinned dependency');
    }
  } else {
    const valueRange = jsonPropertyValueRange(
      original,
      ['dependencies', '@opslane/sdk'],
    );
    if (
      valueRange === null ||
      region.beforeStart < valueRange.start ||
      region.beforeEnd > valueRange.end
    ) {
      addFailure(failures, 'manifest changed bytes outside the Opslane dependency version');
    }
  }

  return [region.newText];
}

function safeRepoFile(
  root: string,
  candidate: string,
  label: string,
  failures: string[],
  maxBytes: number,
): { relative: string; contents: Buffer } | null {
  let relative: string;
  try {
    relative = containedRepoRelative(root, candidate) || '.';
  } catch {
    addFailure(failures, `${label} is not contained in the repository`);
    return null;
  }
  if (relative !== candidate) {
    addFailure(failures, `${label} is not canonical`);
    return null;
  }

  const absolute = path.join(realpathSync(root), relative);
  try {
    const metadata = lstatSync(absolute);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      addFailure(failures, `${label} is not a regular file`);
      return null;
    }
    if (metadata.size > maxBytes) {
      addFailure(failures, `${label} exceeds the verification size limit`);
      return null;
    }
    return { relative, contents: readFileSync(absolute) };
  } catch {
    addFailure(failures, `${label} could not be read`);
    return null;
  }
}

function canonicalEditedSet(
  root: string,
  editedFiles: string[],
  failures: string[],
): Set<string> {
  const result = new Set<string>();
  for (const candidate of editedFiles) {
    try {
      result.add(containedRepoRelative(root, candidate) || '.');
    } catch {
      addFailure(failures, 'reported edited file is not contained in the repository');
    }
  }
  return result;
}

function sameSet(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function parseDotenv(contents: string): DotenvValue[] {
  const values: DotenvValue[] = [];
  for (const line of contents.split(/\r?\n/)) {
    const match =
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (match === null) continue;
    let value = match[2]!.trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (TRIVIAL_DOTENV_VALUES.has(value.toLowerCase())) continue;
    if (value.length < 8) continue;
    values.push({ name: match[1]!, value });
  }
  return values;
}

function dotenvValues(root: string, failures: string[]): DotenvValue[] {
  const realRoot = realpathSync(root);
  const pending = [realRoot];
  const values: DotenvValue[] = [];
  let files = 0;
  let totalBytes = 0;
  let directories = 0;

  while (pending.length > 0) {
    const directory = pending.pop()!;
    directories += 1;
    if (directories > MAX_SCANNED_DIRECTORIES) {
      addFailure(failures, 'dotenv scan exceeded the directory limit');
      return values;
    }
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      addFailure(failures, 'dotenv scan could not read a repository directory');
      return values;
    }

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) pending.push(absolute);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().startsWith('.env')) continue;

      files += 1;
      if (files > MAX_DOTENV_FILES) {
        addFailure(failures, 'dotenv scan exceeded the file limit');
        return values;
      }

      let relative: string;
      let metadata;
      try {
        relative = containedRepoRelative(realRoot, absolute);
        metadata = lstatSync(absolute);
      } catch {
        addFailure(failures, 'dotenv scan encountered an unsafe path');
        return values;
      }
      if (
        relative.length === 0 ||
        metadata.isSymbolicLink() ||
        !metadata.isFile()
      ) {
        continue;
      }
      if (metadata.size > MAX_DOTENV_FILE_BYTES) {
        addFailure(failures, `dotenv file exceeds verification size limit: ${relative}`);
        continue;
      }
      totalBytes += metadata.size;
      if (totalBytes > MAX_DOTENV_TOTAL_BYTES) {
        addFailure(failures, 'dotenv scan exceeded the total byte limit');
        return values;
      }
      try {
        values.push(...parseDotenv(readFileSync(absolute, 'utf8')));
      } catch {
        addFailure(failures, `dotenv file could not be read: ${relative}`);
      }
    }
  }

  return values;
}

function verifyNoNewSecrets(
  root: string,
  added: string[],
  failures: string[],
): void {
  const additions = added.join('\n');
  if (additions.length === 0) return;
  for (const secret of dotenvValues(root, failures)) {
    if (additions.includes(secret.value)) {
      addFailure(
        failures,
        `newly added content contains the value of dotenv variable ${secret.name}`,
      );
    }
  }
}

export function verifyApplied({
  root,
  plan,
  editedFiles,
  originals,
}: VerifyAppliedInput): VerificationResult {
  const failures: string[] = [];
  const expectedFiles = new Set([plan.edit.file, plan.edit.manifest_file]);
  const actualFiles = canonicalEditedSet(root, editedFiles, failures);
  if (!sameSet(actualFiles, expectedFiles)) {
    addFailure(failures, 'edited file set does not match the approved plan');
  }
  if (expectedFiles.size !== 2) {
    addFailure(failures, 'entry and manifest must be distinct files');
  }

  if (sha256(originals.entry) !== plan.edit.entry_hash) {
    addFailure(failures, 'entry snapshot does not match the approved plan');
  }
  if (sha256(originals.manifest) !== plan.edit.manifest_hash) {
    addFailure(failures, 'manifest snapshot does not match the approved plan');
  }

  const entry = safeRepoFile(
    root,
    plan.edit.file,
    'entry file',
    failures,
    MAX_SOURCE_BYTES,
  );
  const manifest = safeRepoFile(
    root,
    plan.edit.manifest_file,
    'manifest file',
    failures,
    MAX_MANIFEST_BYTES,
  );
  const added: string[] = [];

  if (entry !== null) {
    // Guard exact-diff against a lossy UTF-8 decode: an invalid byte decodes to
    // U+FFFD, so two different byte sequences could compare equal as strings and
    // hide a change outside the planned insertion. Once a buffer is valid UTF-8,
    // toString('utf8') round-trips losslessly, so the string diff below IS a byte
    // diff. Source files are valid UTF-8; refuse anything else.
    if (!isValidUtf8(originals.entry) || !isValidUtf8(entry.contents)) {
      addFailure(failures, 'entry file is not valid UTF-8');
    } else {
      const original = stripBom(originals.entry.toString('utf8'));
      const current = stripBom(entry.contents.toString('utf8'));
      const match = exactEntryMatch(original, current, plan);
      if (match === null) {
        addFailure(
          failures,
          'entry file differs by more than the planned import and init insertion',
        );
      } else {
        added.push(...match.added);
      }
      verifySourceStructure(entry.relative, current, plan, failures);
    }
  }

  if (manifest !== null) {
    if (!isValidUtf8(originals.manifest) || !isValidUtf8(manifest.contents)) {
      addFailure(failures, 'manifest file is not valid UTF-8');
    } else {
      added.push(
        ...verifyManifest(
          originals.manifest.toString('utf8'),
          manifest.contents.toString('utf8'),
          plan,
          failures,
        ),
      );
    }
  }

  verifyNoNewSecrets(root, added, failures);
  return { ok: failures.length === 0, failures };
}

export function verifyAlreadyOnboarded({
  root,
  plan,
}: {
  root: string;
  plan: VerifiableOnboardingPlan;
}): VerificationResult {
  const failures: string[] = [];
  const entry = safeRepoFile(
    root,
    plan.edit.file,
    'entry file',
    failures,
    MAX_SOURCE_BYTES,
  );
  const manifest = safeRepoFile(
    root,
    plan.edit.manifest_file,
    'manifest file',
    failures,
    MAX_MANIFEST_BYTES,
  );

  if (manifest !== null) {
    try {
      const value = JSON.parse(manifest.contents.toString('utf8')) as unknown;
      const dependencies = isJsonRecord(value) ? value.dependencies : undefined;
      if (
        !isJsonRecord(dependencies) ||
        typeof dependencies['@opslane/sdk'] !== 'string' ||
        !identityFixedSdkRange(dependencies['@opslane/sdk'])
      ) {
        addFailure(
          failures,
          `manifest does not contain an identity-capable Opslane SDK version (>=${OPSLANE_IDENTITY_MIN_VERSION})`,
        );
      }
    } catch {
      addFailure(failures, 'manifest is not valid JSON');
    }
  }

  if (entry !== null) {
    const extension = path.extname(entry.relative).toLowerCase();
    if (!SUPPORTED_ENTRY_EXTENSIONS.has(extension)) {
      addFailure(failures, `unsupported entry extension: ${extension || '(none)'}`);
    } else {
      const parsed = parseSource(entry.relative, entry.contents.toString('utf8'));
      if (parsed.diagnostics.length > 0) {
        addFailure(failures, 'entry file has a syntax error');
      } else {
        const bindings = sdkBindings(parsed.sourceFile);
        if (
          bindings.initFunctions.size === 0 &&
          bindings.namespaces.size === 0
        ) {
          addFailure(failures, 'entry file has no top-level Opslane SDK import');
        } else if (!hasBoundInitCall(parsed.sourceFile, bindings)) {
          addFailure(failures, 'entry file does not call the imported Opslane initializer');
        }
      }
    }
  }

  return { ok: failures.length === 0, failures };
}
