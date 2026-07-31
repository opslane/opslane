import ts from 'typescript';

import {
  DEFAULT_PLUGIN_CONTRACT,
  type PluginContractDeps,
} from './vite-contract.js';

export type ViteUnsupportedReason =
  | 'no_default_export'
  | 'unsupported_config_shape'
  | 'plugins_not_array'
  | 'plugins_shorthand'
  | 'duplicate_plugins_key'
  | 'plugins_would_be_overwritten'
  | 'unsafe_suggestion'
  | 'plugin_name_taken';

export type PluginListLookup =
  | {
      found: 'list';
      sourceFile: ts.SourceFile;
      config: ts.ObjectLiteralExpression;
      list: ts.ArrayLiteralExpression;
    }
  | {
      found: 'config-only';
      sourceFile: ts.SourceFile;
      config: ts.ObjectLiteralExpression;
    }
  | { found: 'none'; reason: ViteUnsupportedReason };

export interface ViteEditPolicy {
  contract?: PluginContractDeps;
}

export type ViteEditResult =
  | { outcome: 'edited'; text: string; insertOffset: number; line: number }
  | { outcome: 'already_wired'; text: string }
  | { outcome: 'legacy_opslane_plugin'; text?: undefined }
  | { outcome: 'unsupported'; reason: ViteUnsupportedReason; text?: undefined }
  | {
      outcome: 'suggested';
      text: string;
      insertOffset: number;
      line: number;
      preview: string[];
    };

const DEFAULT_POLICY: ViteEditPolicy = {};

function scriptKind(filename: string): ts.ScriptKind {
  if (filename.endsWith('.js') || filename.endsWith('.mjs') || filename.endsWith('.cjs')) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function importBinding(
  sourceFile: ts.SourceFile,
  localName: string,
): { importedName: string; specifier: string } | null {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    if (clause.name?.text === localName) {
      return { importedName: 'default', specifier: statement.moduleSpecifier.text };
    }
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (element.isTypeOnly) continue;
        if (element.name.text === localName) {
          return {
            importedName: element.propertyName?.text ?? element.name.text,
            specifier: statement.moduleSpecifier.text,
          };
        }
      }
    }
  }
  return null;
}

function variableInitializer(sourceFile: ts.SourceFile, name: string): ts.Expression | null {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        return declaration.initializer ?? null;
      }
    }
  }
  return null;
}

function returnedExpression(fn: ts.ArrowFunction | ts.FunctionExpression): ts.Expression | null {
  if (!ts.isBlock(fn.body)) return fn.body;
  const returns = fn.body.statements.filter(ts.isReturnStatement);
  return returns.length === 1 ? returns[0]!.expression ?? null : null;
}

function configObject(
  sourceFile: ts.SourceFile,
  expression: ts.Expression,
  seen = new Set<string>(),
): ts.ObjectLiteralExpression | null {
  const current = unwrap(expression);
  if (ts.isObjectLiteralExpression(current)) return current;

  if (ts.isIdentifier(current)) {
    if (seen.has(current.text)) return null;
    seen.add(current.text);
    const initializer = variableInitializer(sourceFile, current.text);
    return initializer ? configObject(sourceFile, initializer, seen) : null;
  }

  if (ts.isCallExpression(current) && ts.isIdentifier(unwrap(current.expression))) {
    const callee = unwrap(current.expression);
    if (!ts.isIdentifier(callee)) return null;
    const binding = importBinding(sourceFile, callee.text);
    if (
      binding?.importedName === 'defineConfig'
      && (binding.specifier === 'vite' || binding.specifier === 'vitest/config')
      && current.arguments[0]
    ) {
      const argument = unwrap(current.arguments[0]);
      if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) {
        const returned = returnedExpression(argument);
        return returned ? configObject(sourceFile, returned, seen) : null;
      }
      return configObject(sourceFile, argument, seen);
    }
  }
  return null;
}

function propertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) {
    const expression = unwrap(name.expression);
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
      return expression.text;
    }
  }
  return null;
}

/**
 * The plugin array we may insert into.
 *
 * `.filter(Boolean)` is a real shape in the corpus and is safe, because the
 * call we add returns an object. Any other predicate is not: it runs after our
 * insertion and can drop us, leaving a config that reads as correct and
 * registers nothing. Only the genuine global `Boolean` counts, since a local
 * binding of that name can be any predicate at all.
 */
function arrayFromExpression(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
): ts.ArrayLiteralExpression | null {
  const current = unwrap(expression);
  if (ts.isArrayLiteralExpression(current)) return current;
  if (
    ts.isCallExpression(current)
    && ts.isPropertyAccessExpression(current.expression)
    && current.expression.name.text === 'filter'
  ) {
    const receiver = unwrap(current.expression.expression);
    if (!ts.isArrayLiteralExpression(receiver)) return null;
    if (current.arguments.length !== 1) return null;
    const predicate = unwrap(current.arguments[0]!);
    if (!ts.isIdentifier(predicate) || predicate.text !== 'Boolean') return null;
    const shadowed = topLevelBindingNames(sourceFile).has('Boolean')
      || enclosingScopeBindings(current, sourceFile).has('Boolean');
    return shadowed ? null : receiver;
  }
  return null;
}

export function findPluginList(text: string, filename: string): PluginListLookup {
  const sourceFile = ts.createSourceFile(
    filename,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(filename),
  );
  const parseDiagnostics = (sourceFile as unknown as { parseDiagnostics: readonly unknown[] })
    .parseDiagnostics;
  if (parseDiagnostics.length > 0) {
    return { found: 'none', reason: 'unsupported_config_shape' };
  }
  const defaultExport = sourceFile.statements.find(
    (statement): statement is ts.ExportAssignment =>
      ts.isExportAssignment(statement) && !statement.isExportEquals,
  );
  if (!defaultExport) return { found: 'none', reason: 'no_default_export' };

  const config = configObject(sourceFile, defaultExport.expression);
  if (!config) return { found: 'none', reason: 'unsupported_config_shape' };

  const pluginProperties = config.properties.filter((property) =>
    !ts.isSpreadAssignment(property)
    && 'name' in property
    && Boolean(property.name)
    && propertyName(property.name!) === 'plugins',
  );
  if (pluginProperties.length > 1) {
    return { found: 'none', reason: 'duplicate_plugins_key' };
  }
  for (const property of pluginProperties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      return { found: 'none', reason: 'plugins_shorthand' };
    }
    if (!ts.isPropertyAssignment(property)) {
      return { found: 'none', reason: 'plugins_not_array' };
    }
    const list = arrayFromExpression(property.initializer, sourceFile);
    if (!list) return { found: 'none', reason: 'plugins_not_array' };
    return { found: 'list', sourceFile, config, list };
  }
  const hasUnknownComputedProperty = config.properties.some((property) =>
    'name' in property
    && property.name
    && ts.isComputedPropertyName(property.name)
    && propertyName(property.name) === null,
  );
  if (hasUnknownComputedProperty) {
    return { found: 'none', reason: 'unsupported_config_shape' };
  }
  return { found: 'config-only', sourceFile, config };
}

function lineEnding(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function lineStart(text: string, position: number): number {
  return text.lastIndexOf('\n', Math.max(0, position - 1)) + 1;
}

function indentationAt(text: string, position: number): string {
  return text.slice(lineStart(text, position), position).match(/^[\t ]*/)?.[0] ?? '';
}

function lineNumberAt(text: string, position: number): number {
  return text.slice(0, position).split(/\r?\n/).length;
}

function importInsertion(sourceFile: ts.SourceFile, text: string, importLine: string): {
  offset: number;
  text: string;
} {
  const eol = lineEnding(text);
  const imports = sourceFile.statements.filter(ts.isImportDeclaration);
  const last = imports.at(-1);
  if (!last) {
    const offset = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    return { offset, text: `${importLine}${eol}` };
  }

  let end = last.getEnd();
  for (const comment of ts.getTrailingCommentRanges(text, end) ?? []) {
    if (!/^[\t ]*$/.test(text.slice(end, comment.pos))) break;
    end = comment.end;
  }
  const newline = text.indexOf('\n', end);
  if (newline === -1) {
    return { offset: text.length, text: `${eol}${importLine}${eol}` };
  }
  return { offset: newline + 1, text: `${importLine}${eol}` };
}

function pluginInsertion(
  text: string,
  lookup: Extract<PluginListLookup, { found: 'list' }>,
  callText: string,
): { offset: number; text: string; line: number } {
  const { list } = lookup;
  const eol = lineEnding(text);
  const offset = list.elements.end;
  const last = list.elements.at(-1);
  const propertyLineIndent = indentationAt(text, list.getStart(lookup.sourceFile));
  const singleLine = !text.slice(list.getStart(lookup.sourceFile), list.getEnd()).includes('\n');
  const indent = last && !singleLine
    ? indentationAt(text, last.getStart(lookup.sourceFile))
    : `${propertyLineIndent}  `;
  const comma = list.elements.length > 0 && !list.elements.hasTrailingComma ? ',' : '';
  const insertion = `${comma}${eol}${indent}${callText}`;
  return {
    offset,
    text: insertion,
    line: lineNumberAt(text, offset) + 1,
  };
}

function configPropertyInsertion(
  text: string,
  lookup: Extract<PluginListLookup, { found: 'config-only' }>,
  callText: string,
): { offset: number; text: string; line: number } {
  const { config, sourceFile } = lookup;
  const eol = lineEnding(text);
  const offset = config.properties.end;
  const closingIndent = indentationAt(text, config.getEnd() - 1);
  const propertyIndent = `${closingIndent}  `;
  const comma = config.properties.length > 0 && !config.properties.hasTrailingComma ? ',' : '';
  const insertion = `${comma}${eol}${propertyIndent}plugins: [${eol}${propertyIndent}  ${callText}${eol}${propertyIndent}]`;
  return {
    offset,
    text: insertion,
    line: lineNumberAt(text, offset) + 2,
  };
}

function importedFactoryLocalName(
  sourceFile: ts.SourceFile,
  contract: PluginContractDeps,
): string | null {
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== contract.specifier
    ) continue;
    const bindings = statement.importClause?.namedBindings;
    if (statement.importClause?.isTypeOnly || !bindings || !ts.isNamedImports(bindings)) continue;
    const current = new Set<string>(contract.exportNames ?? [contract.exportName]);
    const factory = bindings.elements.find(
      (element) => !element.isTypeOnly
        && current.has(element.propertyName?.text ?? element.name.text),
    );
    if (factory) return factory.name.text;
  }
  return null;
}

/**
 * True only when the list holds `localName()` as a direct element.
 *
 * An earlier version searched anywhere inside an element, which reported
 * `plugins: [process.env.CI && opslane()]` as already wired. That registers the
 * plugin only when the condition happens to be true, so treating it as proof
 * tells the customer source maps are on when they are not. A nested call is not
 * a registration, and adding an unconditional sibling is the safe answer.
 */
function listCallsFactory(
  list: ts.ArrayLiteralExpression,
  sourceFile: ts.SourceFile,
  localName: string,
): boolean {
  return list.elements.some((element) => {
    const call = unwrap(element);
    if (!ts.isCallExpression(call) || call.arguments.length > 0) return false;
    const callee = unwrap(call.expression);
    return ts.isIdentifier(callee)
      && callee.text === localName
      && call.getSourceFile() === sourceFile;
  });
}

function importedSpecifiers(sourceFile: ts.SourceFile): string[] {
  return sourceFile.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      return [];
    }
    const clause = statement.importClause;
    if (clause?.isTypeOnly) return [];
    const named = clause?.namedBindings;
    if (
      named
      && ts.isNamedImports(named)
      && !clause.name
      && named.elements.every((element) => element.isTypeOnly)
    ) return [];
    return [statement.moduleSpecifier.text];
  });
}

function runtimeImportsFrom(sourceFile: ts.SourceFile, specifier: string): string[] {
  return sourceFile.statements.flatMap((statement) => {
    if (
      !ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== specifier
      || statement.importClause?.isTypeOnly
    ) return [];
    const clause = statement.importClause;
    if (!clause) return ['side-effect'];
    const names: string[] = [];
    if (clause.name) names.push('default');
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) names.push('*');
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        if (!element.isTypeOnly) names.push(element.propertyName?.text ?? element.name.text);
      }
    }
    return names;
  });
}

function pluginWouldBeOverwritten(lookup: Exclude<PluginListLookup, { found: 'none' }>): boolean {
  const pluginIndex = lookup.found === 'list'
    ? lookup.config.properties.findIndex(
        (candidate) => 'name' in candidate
          && Boolean(candidate.name)
          && propertyName(candidate.name!) === 'plugins',
      )
    : -1;
  return lookup.config.properties.some((property, index) =>
    ts.isSpreadAssignment(property)
    && (lookup.found === 'config-only' || index > pluginIndex),
  );
}

function addBindingName(name: ts.BindingName, names: Set<string>): void {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) addBindingName(element.name, names);
  }
}

/** Declarations a single statement contributes to whatever scope holds it. */
function addStatementBindings(statement: ts.Statement, names: Set<string>): void {
  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      addBindingName(declaration.name, names);
    }
    return;
  }
  if (
    (ts.isFunctionDeclaration(statement)
      || ts.isClassDeclaration(statement)
      || ts.isEnumDeclaration(statement)
      || ts.isModuleDeclaration(statement)
      || ts.isImportEqualsDeclaration(statement)
      || ts.isTypeAliasDeclaration(statement)
      || ts.isInterfaceDeclaration(statement))
    && statement.name
    && ts.isIdentifier(statement.name)
  ) {
    names.add(statement.name.text);
  }
}

/**
 * Names bound by the scopes between `node` and the top of the file. Our import
 * is added at the top, so a call inserted inside one of these scopes resolves
 * to the customer's binding rather than ours. The parser accepts that happily,
 * and the file reads as correct while registering somebody else's plugin.
 */
function enclosingScopeBindings(node: ts.Node, sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (
    let current: ts.Node | undefined = node.parent;
    current && current !== sourceFile;
    current = current.parent
  ) {
    if (ts.isFunctionLike(current)) {
      for (const parameter of current.parameters) addBindingName(parameter.name, names);
    }
    if (ts.isBlock(current) || ts.isModuleBlock(current)) {
      for (const statement of current.statements) addStatementBindings(statement, names);
    }
    if (
      (ts.isForStatement(current) || ts.isForOfStatement(current) || ts.isForInStatement(current))
      && current.initializer
      && ts.isVariableDeclarationList(current.initializer)
    ) {
      for (const declaration of current.initializer.declarations) {
        addBindingName(declaration.name, names);
      }
    }
  }
  return names;
}

/**
 * Every name the config already binds at the top level. Inserting our import
 * next to a binding of the same name is a redeclaration, which the TypeScript
 * parser accepts as valid grammar, so nothing downstream would notice.
 */
function topLevelBindingNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const addBinding = (name: ts.BindingName): void => addBindingName(name, names);
  // `var` is scoped to the module, not to the block it sits in, so a
  // declaration buried in top-level control flow still collides with the
  // import. Walk into those statements, but stop at anything that opens a new
  // scope, because a binding in there cannot collide.
  const addHoistedVars = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node)
      || ts.isFunctionExpression(node)
      || ts.isArrowFunction(node)
      || ts.isClassDeclaration(node)
      || ts.isClassExpression(node)
      || ts.isModuleDeclaration(node)
    ) return;
    if (
      ts.isVariableDeclarationList(node)
      && (node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0
    ) {
      for (const declaration of node.declarations) addBinding(declaration.name);
    }
    node.forEachChild(addHoistedVars);
  };

  for (const statement of sourceFile.statements) {
    addHoistedVars(statement);
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (!clause) continue;
      if (clause.name) names.add(clause.name.text);
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) names.add(element.name.text);
      }
    } else {
      // Enums, namespaces and `import x = require()` all declare a runtime
      // value. Type aliases and interfaces are erased, but a redeclaration
      // still fails the customer's own type check, and refusing costs them
      // only the documented manual path.
      addStatementBindings(statement, names);
    }
  }
  return names;
}

function policyTerminal(
  lookup: Exclude<PluginListLookup, { found: 'none' }>,
  policy: ViteEditPolicy,
  contract: PluginContractDeps,
): ViteEditResult | undefined {
  if (pluginWouldBeOverwritten(lookup)) {
    return { outcome: 'unsupported', reason: 'plugins_would_be_overwritten' };
  }
  const factoryLocal = importedFactoryLocalName(lookup.sourceFile, contract);
  // The SDK exports the same factory under more than one name. Importing any of
  // them means the config is already on the current plugin; only a different
  // export from that subpath is the deprecated uploader.
  const currentNames = new Set<string>(contract.exportNames ?? [contract.exportName]);
  const contractImports = runtimeImportsFrom(lookup.sourceFile, contract.specifier);
  if (contractImports.some((name) => !currentNames.has(name))) {
    return { outcome: 'legacy_opslane_plugin' };
  }
  if (
    lookup.found === 'list'
    && factoryLocal
    && listCallsFactory(lookup.list, lookup.sourceFile, factoryLocal)
  ) {
    return { outcome: 'already_wired', text: lookup.sourceFile.text };
  }
  // Without an existing binding we insert `contract.importLine`, which declares
  // `contract.exportName`. If the config already binds that name, the edit is a
  // redeclaration that parses cleanly and then fails at runtime, and any call
  // already in the plugin list silently changes meaning. Refuse instead.
  // The import lands at the top of the file, but the call lands wherever the
  // plugin list is. Both have to be clear of the name, so check the top level
  // and every scope between it and the insertion point.
  const insertionNode: ts.Node = lookup.found === 'list' ? lookup.list : lookup.config;
  if (
    !factoryLocal
    && (topLevelBindingNames(lookup.sourceFile).has(contract.exportName)
      || enclosingScopeBindings(insertionNode, lookup.sourceFile).has(contract.exportName))
  ) {
    return { outcome: 'unsupported', reason: 'plugin_name_taken' };
  }
  return undefined;
}

function listNeedsSuggestion(
  lookup: Extract<PluginListLookup, { found: 'list' }>,
): boolean {
  const property = lookup.config.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) && propertyName(candidate.name) === 'plugins',
  );
  return property !== undefined && !ts.isArrayLiteralExpression(unwrap(property.initializer));
}

export function addOpslanePlugin(
  text: string,
  filename: string,
  policy: ViteEditPolicy = DEFAULT_POLICY,
): ViteEditResult {
  const contract = policy.contract ?? DEFAULT_PLUGIN_CONTRACT;
  const lookup = findPluginList(text, filename);
  if (lookup.found === 'none') {
    return { outcome: 'unsupported', reason: lookup.reason };
  }

  const terminal = policyTerminal(lookup, policy, contract);
  if (terminal) return terminal;
  const factoryLocal = importedFactoryLocalName(lookup.sourceFile, contract);

  const callText = factoryLocal ? `${factoryLocal}()` : contract.callText;
  const plugin = lookup.found === 'list'
    ? pluginInsertion(text, lookup, callText)
    : configPropertyInsertion(text, lookup, callText);
  const importEdit = !factoryLocal
    ? importInsertion(lookup.sourceFile, text, contract.importLine)
    : undefined;
  const edits = [
    { offset: plugin.offset, text: plugin.text },
    ...(importEdit ? [importEdit] : []),
  ].sort((left, right) => right.offset - left.offset);
  let output = text;
  for (const edit of edits) {
    output = output.slice(0, edit.offset) + edit.text + output.slice(edit.offset);
  }
  const outputCallOffset = plugin.offset
    + plugin.text.indexOf(callText)
    + (importEdit && importEdit.offset <= plugin.offset ? importEdit.text.length : 0);
  const outputLine = lineNumberAt(output, outputCallOffset);
  if (lookup.found === 'list' && listNeedsSuggestion(lookup)) {
    return {
      outcome: 'suggested',
      text: output,
      insertOffset: plugin.offset,
      line: outputLine,
      preview: output.split(/\r?\n/).slice(Math.max(0, outputLine - 3), outputLine + 2),
    };
  }
  return {
    outcome: 'edited',
    text: output,
    insertOffset: plugin.offset,
    line: outputLine,
  };
}

export function suggestionAtLine(
  text: string,
  filename: string,
  line: number,
  policy: ViteEditPolicy = DEFAULT_POLICY,
): ViteEditResult {
  const lookup = findPluginList(text, filename);
  if (lookup.found !== 'list' || line < 1) {
    return { outcome: 'unsupported', reason: 'unsafe_suggestion' };
  }
  const contract = policy.contract ?? DEFAULT_PLUGIN_CONTRACT;
  const terminal = policyTerminal(lookup, policy, contract);
  if (terminal) return terminal;
  const starts = [0];
  for (const match of text.matchAll(/\r?\n/g)) starts.push((match.index ?? 0) + match[0].length);
  const offset = starts[line - 1];
  if (offset === undefined || offset < lookup.list.getStart() || offset > lookup.list.getEnd()) {
    return { outcome: 'unsupported', reason: 'unsafe_suggestion' };
  }
  const indent = text.slice(offset).match(/^[\t ]*/)?.[0] ?? '';
  const factoryLocal = importedFactoryLocalName(lookup.sourceFile, contract);
  const insertion = `${indent}${factoryLocal ? `${factoryLocal}()` : contract.callText},${lineEnding(text)}`;
  const edits = [
    { offset, text: insertion },
    ...(!factoryLocal
      ? [importInsertion(lookup.sourceFile, text, contract.importLine)]
      : []),
  ].sort((left, right) => right.offset - left.offset);
  let edited = text;
  for (const edit of edits) {
    edited = edited.slice(0, edit.offset) + edit.text + edited.slice(edit.offset);
  }
  const structural = addOpslanePlugin(edited, filename, policy);
  if (structural.outcome !== 'already_wired') {
    return { outcome: 'unsupported', reason: 'unsafe_suggestion' };
  }
  return {
    outcome: 'suggested',
    text: edited,
    insertOffset: offset,
    line,
    preview: edited.split(/\r?\n/).slice(Math.max(0, line - 3), line + 2),
  };
}

export function configSetsBuildSourcemap(text: string, filename: string): boolean {
  const lookup = findPluginList(text, filename);
  if (lookup.found === 'none') return false;
  const build = lookup.config.properties.find((property) =>
    ts.isPropertyAssignment(property) && propertyName(property.name) === 'build',
  );
  if (!build || !ts.isPropertyAssignment(build)) return false;
  const buildObject = unwrap(build.initializer);
  return ts.isObjectLiteralExpression(buildObject)
    && buildObject.properties.some((property) =>
      'name' in property && Boolean(property.name) && propertyName(property.name!) === 'sourcemap',
    );
}
