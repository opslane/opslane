#!/usr/bin/env node
// Docs drift check: fails (exit 1) when reference docs and source disagree.
//
// Checks (each bidirectional):
//   1. SDK fetch calls (method + path, incl. vite-plugin) vs routes registered in routes.go
//   2. Registered routes vs docs/reference/http-routes.md (method-aware)
//   3. Env vars read by ingestion/worker vs docs/reference/environment-variables.md,
//      with documented-but-unread vars allowed only in the dead-config section
//   4. SdkInitOptions keys and defaults vs docs/reference/sdk-options.md
//   5. ReasonCode union vs docs/reference/reason-codes.md
//   6. Local paths linked from llms.txt exist
//
// Run: pnpm docs:check  (wired into the root `pnpm test` gate)
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDocsIndex, findUncoveredProseDocs } from './docs-map.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const problems = [];

// Known drift, allowlisted with a tracking issue. Remove entries as bugs close.
const KNOWN_DRIFT = new Map([]);

// ---------- prose-doc coverage metadata ----------
for (const doc of findUncoveredProseDocs(buildDocsIndex(root))) {
  problems.push(`${doc} is a prose-tier doc but does not declare a non-empty covers: list`);
}

const normalize = (p) => p.replace(/\{[^}]+\}/g, '{param}');

// ---------- registered routes (method + path) ----------
function registeredRoutes() {
  const src = read('packages/ingestion/handler/routes.go');
  const routes = new Set();
  const prefixStack = [];
  let depth = 0;
  for (const line of src.split('\n')) {
    const routeM = line.match(/r\.Route\("([^"]+)"/);
    const methodM = line.match(/\.(Get|Post|Put|Patch|Delete|HandleFunc)\("(\/[^"]*)"/);
    if (methodM && !routeM) {
      const prefix = prefixStack.map((p) => p.prefix).join('');
      const path = normalize(prefix + methodM[2]);
      const method = methodM[1] === 'HandleFunc' ? 'ANY' : methodM[1].toUpperCase();
      routes.add(`${method} ${path}`);
    }
    depth += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length;
    if (routeM) prefixStack.push({ prefix: routeM[1], depth });
    while (prefixStack.length && depth < prefixStack.at(-1).depth) prefixStack.pop();
  }
  return routes;
}

const routes = registeredRoutes();
const routeHas = (method, path) =>
  routes.has(`${method} ${path}`) || routes.has(`ANY ${path}`);

// ---------- 1. SDK calls (any *endpoint* template, any dir, method-aware) ----------
function* tsFiles(dir) {
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (e.isDirectory() && !['node_modules', '__tests__', 'dist'].includes(e.name)) yield* tsFiles(join(dir, e.name));
    else if (e.name.endsWith('.ts') && !e.name.includes('.test.')) yield join(dir, e.name);
  }
}
function sdkCalls() {
  const calls = new Set();
  for (const f of [...tsFiles('packages/sdk/src'), ...tsFiles('packages/sdk/vite-plugin')]) {
    const src = readFileSync(join(root, f), 'utf8');
    for (const m of src.matchAll(/fetch\(\s*`\$\{[^}]*endpoint[^}]*\}(\/api\/v1\/[^`]+)`/gi)) {
      const path = normalize(m[1].replace(/\$\{[^}]+\}/g, '{param}').replace(/\?.*$/, ''));
      // Method: nearest `method: 'X'` within the fetch options (next ~300 chars)
      const after = src.slice(m.index, m.index + 300);
      const methodM = after.match(/method:\s*['"](GET|POST|PUT|PATCH|DELETE)['"]/i);
      calls.add(`${(methodM?.[1] ?? 'GET').toUpperCase()} ${path}`);
    }
  }
  return calls;
}
for (const call of sdkCalls()) {
  const [method, path] = call.split(' ');
  if (!routeHas(method, path)) {
    if (KNOWN_DRIFT.has(call)) {
      console.warn(`⚠ known drift (allowlisted): SDK calls unregistered ${call} — ${KNOWN_DRIFT.get(call)}`);
    } else {
      problems.push(`SDK calls ${call} but routes.go does not register it`);
    }
  }
}

// ---------- 2. Route docs (method-aware, both directions) ----------
const routeDoc = read('docs/reference/http-routes.md');
const docRoutes = new Set();
for (const m of routeDoc.matchAll(/^\|\s*([A-Z+]+|HMAC)\s*\|\s*`([^`]+)`/gm)) {
  const path = normalize(m[2]);
  const methods = m[1] === 'HMAC' ? ['POST'] : m[1].split('+');
  for (const method of methods) docRoutes.add(`${method === 'GET+POST' ? 'ANY' : method} ${path}`);
}
// GET+POST in docs === ANY (HandleFunc) in code
const docHas = (r) => {
  const [method, path] = r.split(' ');
  return docRoutes.has(r) || (method === 'ANY' && docRoutes.has(`GET ${path}`) && docRoutes.has(`POST ${path}`));
};
for (const r of routes) {
  if (!docHas(r)) problems.push(`route ${r} is registered but missing from docs/reference/http-routes.md`);
}
for (const r of docRoutes) {
  const [method, path] = r.split(' ');
  if (!routeHas(method, path) && !KNOWN_DRIFT.has(r)) {
    problems.push(`docs/reference/http-routes.md documents ${r} but routes.go does not register it`);
  }
}

// ---------- 3. Env vars (both directions, dead-config allowlist) ----------
function goEnvVars() {
  const vars = new Set();
  const walk = (dir) => {
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== 'node_modules') walk(join(dir, e.name));
      else if (e.name.endsWith('.go') && !e.name.endsWith('_test.go')) {
        for (const m of readFileSync(join(root, dir, e.name), 'utf8').matchAll(/os\.Getenv\("([A-Z0-9_]+)"\)/g)) vars.add(m[1]);
      }
    }
  };
  walk('packages/ingestion');
  return vars;
}
function workerEnvVars() {
  const vars = new Set();
  for (const f of tsFiles('packages/worker/src')) {
    const source = readFileSync(join(root, f), 'utf8');
    for (const m of source.matchAll(/process\.env\[?['"]([A-Z0-9_]+)['"]\]?/g)) vars.add(m[1]);
    // Config modules that take the environment as a parameter read their names
    // through a helper, so the literal never sits next to `process.env`. The
    // name is still a literal in worker source; follow it.
    for (const m of source.matchAll(/readVar\([^,]+,\s*['"]([A-Z0-9_]+)['"]\s*\)/g)) vars.add(m[1]);
  }
  vars.delete('VITEST'); // test-runner detection, not configuration
  return vars;
}
function sdkBuildEnvVars() {
  const vars = new Set();
  const source = read('packages/sdk/vite-plugin/index.ts');
  for (const m of source.matchAll(/env\?\.(\b[A-Z][A-Z0-9_]+\b)/g)) {
    vars.add(m[1]);
  }
  const commitLadder = source.match(/const names = \[([\s\S]*?)\];/);
  for (const m of (commitLadder?.[1] ?? '').matchAll(/['"]([A-Z][A-Z0-9_]+)['"]/g)) {
    vars.add(m[1]);
  }
  return vars;
}
// Vars consumed indirectly: read by a dependency, not via a literal process.env
// access this scanner can see. Each entry names its consumer.
const INDIRECT_VARS = new Map([
  ['E2B_API_KEY', 'read internally by the e2b SDK when the worker creates sandboxes'],
]);
const codeVars = new Set([
  ...goEnvVars(),
  ...workerEnvVars(),
  ...sdkBuildEnvVars(),
  ...INDIRECT_VARS.keys(),
]);
const envDoc = read('docs/reference/environment-variables.md');
for (const v of codeVars) {
  if (!envDoc.includes(v)) problems.push(`env var ${v} is read by code but missing from docs/reference/environment-variables.md`);
}
// Reverse: every backticked ALL_CAPS var in the doc must be read by code,
// unless listed in the dead-config section (which is itself the allowlist).
const deadSection = envDoc.split(/## Set in Compose but consumed by no code/)[1] ?? '';
const deadVars = new Set([...deadSection.matchAll(/`([A-Z0-9_]+)`/g)].map((m) => m[1]));
for (const m of envDoc.matchAll(/`([A-Z0-9_]{3,})`/g)) {
  const v = m[1];
  if (/^(GET|POST|PUT|PATCH|DELETE|HMAC|ANY|SHA|JWT|PII|API|MIT|AGPL|CORS|DNS|PAT|PEM)/.test(v) && !v.includes('_')) continue;
  if (!/^[A-Z0-9]+(_[A-Z0-9]+)+$|^PORT$|^VERSION$/.test(v)) continue;
  if (!codeVars.has(v) && !deadVars.has(v)) {
    problems.push(`env var ${v} is documented but not read by any code (move to the dead-config section or remove)`);
  }
}

// ---------- 4. SDK options (keys + defaults, both directions) ----------
const configSrc = read('packages/sdk/src/config.ts');
const optsM = configSrc.match(/export interface SdkInitOptions \{([\s\S]*?)\}/);
const optionKeys = [...(optsM?.[1] ?? '').matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]);
if (optionKeys.length === 0) problems.push('could not parse SdkInitOptions from packages/sdk/src/config.ts');
const defaultsM = configSrc.match(/const DEFAULTS[^=]*= \{([\s\S]*?)\};/);
const defaults = Object.fromEntries(
  [...(defaultsM?.[1] ?? '').matchAll(/(\w+):\s*([\w.'"]+)/g)].map((m) => [m[1], m[2].replaceAll('_', '').replaceAll("'", '')])
);
const sdkDoc = read('docs/reference/sdk-options.md');
for (const k of optionKeys) {
  if (!sdkDoc.includes(`\`${k}\``)) problems.push(`SDK option ${k} exists in SdkInitOptions but is missing from docs/reference/sdk-options.md`);
}
for (const m of sdkDoc.matchAll(/^\| `(\w+)` \|/gm)) {
  if (!optionKeys.includes(m[1])) problems.push(`SDK option ${m[1]} is documented but absent from SdkInitOptions`);
}
for (const [key, val] of Object.entries(defaults)) {
  if (/^\d+$/.test(val) && !sdkDoc.includes(`\`${val}\``)) {
    problems.push(`SDK default ${key}=${val} (config.ts DEFAULTS) does not appear in docs/reference/sdk-options.md`);
  }
}

// ---------- 5. Reason codes (both directions + count) ----------
const typesSrc = read('shared/src/types.ts');
const unionM = typesSrc.match(/export type ReasonCode =([\s\S]*?);/);
const codes = [...(unionM?.[1] ?? '').matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
if (codes.length === 0) problems.push('could not parse ReasonCode union from shared/src/types.ts');
const reasonDoc = read('docs/reference/reason-codes.md');
for (const c of codes) {
  if (!reasonDoc.includes(`\`${c}\``)) problems.push(`reason code ${c} exists in shared/src/types.ts but is missing from docs/reference/reason-codes.md`);
}
for (const m of reasonDoc.matchAll(/^\| `([a-z0-9_]+)` \|/gm)) {
  if (!codes.includes(m[1])) problems.push(`reason code ${m[1]} is documented but absent from shared/src/types.ts`);
}
const countM = reasonDoc.match(/(\d+) codes total/);
if (countM && Number(countM[1]) !== codes.length) {
  problems.push(`reason-codes.md says "${countM[1]} codes total" but shared/src/types.ts defines ${codes.length}`);
}

// ---------- 6. llms.txt local paths ----------
const llms = read('llms.txt');
let llmsPathCount = 0;
for (const m of llms.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
  const target = m[1].trim();
  if (target.startsWith('#') || target.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(target)) continue;

  llmsPathCount += 1;
  const path = target.replace(/^<|>$/g, '').split(/[?#]/, 1)[0];
  const resolved = path ? resolve(root, decodeURIComponent(path)) : '';
  const insideRepo = resolved.startsWith(root + sep);
  if (!insideRepo || !existsSync(resolved) || !statSync(resolved).isFile()) {
    problems.push(`llms.txt links to missing local path ${target}`);
  }
}

// ---------- 7. every published doc appears in llms.txt ----------
// llms.txt is the machine entry point. A published page missing from it is
// invisible to any agent that starts there, which is how it silently drifted
// twelve pages behind the docs tree.
const { checkDocsScope } = await import('./check-docs-scope.mjs');
const publishedDocs = checkDocsScope({ root }).published.filter(
  (docPath) => !read(docPath).startsWith('---\ndraft: true'),
);
const missingFromLlms = publishedDocs.filter((docPath) => !llms.includes(`(${docPath})`));
if (missingFromLlms.length > 0) {
  problems.push(
    `llms.txt is missing ${missingFromLlms.length} published page(s): ${missingFromLlms.join(', ')}`,
  );
}

// ---------- verdict ----------
if (problems.length > 0) {
  console.error(`✗ docs drift detected (${problems.length}):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `✓ no docs drift: ${routes.size} routes, ${codeVars.size} env vars, ${optionKeys.length} SDK options, ${codes.length} reason codes, and ${llmsPathCount} llms.txt paths all consistent`
);
