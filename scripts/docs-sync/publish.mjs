#!/usr/bin/env node
import { createHmac } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeRepoPath } from './plan.mjs';
import {
  loadSnippetManifest,
  validateContentEdit,
  validateSiteOverlay,
} from './validation.mjs';

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:sk-ant-(?:api|oat)\d*|sk_live|gh[opusr]_|github_pat_)[A-Za-z0-9_-]{16,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  // Opslane project keys: prefix, 26-char key id, then the secret (and, on an
  // sk, the endpoint payload). Documentation may name the prefixes in prose;
  // only a fully formed key -- key id and material -- is refused.
  /opslane_(?:pk|sk)_[A-Za-z0-9_-]{26}_[A-Za-z0-9_-]+/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\b(?:CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)\s*[:=]\s*\S+/i,
  /\b[A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{20,}/,
];

function checkedRunner(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stderr || result.stdout}`);
  return result.stdout ?? '';
}

export function parsePorcelainZ(text) {
  const tokens = text.split('\0').filter(Boolean);
  const paths = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const record = tokens[i];
    if (record.length < 4) throw new Error('malformed git status --porcelain -z output');
    paths.push(record.slice(3));
    if (/^[RC]/.test(record) || /^[RC]/.test(record.slice(1))) paths.push(tokens[++i]);
  }
  return paths;
}

function fingerprintMatches(text, item) {
  // Fail closed: a malformed fingerprint is treated as a match so publishDocs
  // aborts rather than silently skipping the leak check.
  if (
    !Number.isSafeInteger(item.length) ||
    item.length < 1 ||
    !/^[0-9a-f]{32}$/.test(item.salt) ||
    !/^[0-9a-f]{64}$/.test(item.hmac)
  ) {
    return true;
  }
  const candidates = text.match(/[A-Za-z0-9_./+=-]{16,}/g) ?? [];
  return candidates.some((candidate) => {
    if (candidate.length < item.length) return false;
    for (let i = 0; i <= candidate.length - item.length; i += 1) {
      if (createHmac('sha256', item.salt).update(candidate.slice(i, i + item.length)).digest('hex') === item.hmac) return true;
    }
    return false;
  });
}

export function assertSecretFree(text, fingerprints = []) {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) throw new Error('secret pattern detected in staged documentation');
  if (fingerprints.some((item) => fingerprintMatches(text, item))) throw new Error('exact protected secret detected in staged documentation');
}

function listFiles(root, rel = '') {
  const full = join(root, rel);
  const out = [];
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    const child = posix.join(rel, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`staging symlink rejected: ${child}`);
    if (entry.isDirectory()) out.push(...listFiles(root, child));
    else if (entry.isFile()) out.push(child);
    else throw new Error(`non-regular staging entry rejected: ${child}`);
  }
  return out;
}

function assertSafeDestination(root, repoPath) {
  let current = root;
  for (const segment of repoPath.split('/')) {
    current = join(current, segment);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`destination symlink rejected: ${repoPath}`);
      if (current !== join(root, repoPath) && !stat.isDirectory()) throw new Error(`destination parent is not a directory: ${repoPath}`);
      if (current === join(root, repoPath) && !stat.isFile()) throw new Error(`destination is not a regular file: ${repoPath}`);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
  }
}

export function validateHeadRef(value) {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('-') || /[\s~^:?*[\\]/.test(value) || value.includes('..')) {
    throw new Error(`unsafe head ref: ${String(value)}`);
  }
  return value;
}

export function overlayStagedDocs({
  stagingDir,
  map,
  artifact,
  checkoutRoot,
  expectedHeadSha,
  snippetManifest,
  contentValidator = validateContentEdit,
  reportWarning = (warning) => console.warn(`::warning title=Docs sync quality::${warning.message}`),
}) {
  if (!/^[0-9a-f]{40}$/.test(expectedHeadSha) || artifact.headSha !== expectedHeadSha) {
    throw new Error('artifact/head SHA mismatch');
  }
  const allowed = new Set((map.matched ?? []).map(normalizeRepoPath));
  const changed = (artifact.changed ?? []).map(normalizeRepoPath).sort();
  const docsRoot = join(stagingDir, 'docs');
  let staged = [];
  try { staged = listFiles(docsRoot).map((path) => `docs/${path}`).sort(); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  if (JSON.stringify(staged) !== JSON.stringify(changed)) throw new Error('staging files do not match changed-docs manifest');
  for (const repoPath of staged) {
    if (!allowed.has(repoPath)) throw new Error(`staged path is outside matched allowlist: ${repoPath}`);
    const source = join(stagingDir, repoPath);
    const sourceStat = lstatSync(source);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error(`staged source is not a regular file: ${repoPath}`);
    const text = readFileSync(source, 'utf8');
    assertSecretFree(text, artifact.secretFingerprints ?? []);
    assertSafeDestination(checkoutRoot, repoPath);
    const original = readFileSync(join(checkoutRoot, repoPath), 'utf8');
    const validation = contentValidator({ docPath: repoPath, original, edited: text, snippetManifest });
    for (const warning of validation?.warnings ?? []) reportWarning(warning);
  }
  for (const repoPath of staged) {
    const destination = join(checkoutRoot, repoPath);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(stagingDir, repoPath), destination);
  }
  return { staged, allowed };
}

export async function publishDocs({
  stagingDir,
  map,
  artifact,
  checkoutRoot,
  trustedRoot = resolve(fileURLToPath(new URL('../../', import.meta.url))),
  headSha,
  headRef,
  prNumber,
  runner = checkedRunner,
  snippetManifest = loadSnippetManifest(),
  contentValidator = validateContentEdit,
  stage2Validator = validateSiteOverlay,
  reportWarning = (warning) => console.warn(`::warning title=Docs sync quality::${warning.message}`),
}) {
  validateHeadRef(headRef);
  if (!/^\d+$/.test(String(prNumber))) throw new Error('invalid PR number');
  const { staged, allowed } = overlayStagedDocs({
    stagingDir,
    map,
    artifact,
    checkoutRoot,
    expectedHeadSha: headSha,
    snippetManifest,
    contentValidator,
    reportWarning,
  });
  if (staged.length === 0) return { pushed: false, reason: 'empty' };
  stage2Validator({ checkoutRoot, trustedRoot, runner });
  const status = runner('git', ['-C', checkoutRoot, 'status', '--porcelain=v1', '-z']);
  if (!status) return { pushed: false, reason: 'clean' };
  const dirty = parsePorcelainZ(status).map(normalizeRepoPath);
  if (dirty.some((path) => !allowed.has(path))) throw new Error(`checkout contains a change outside matched allowlist: ${dirty.join(', ')}`);
  runner('git', ['-C', checkoutRoot, 'add', '--', ...staged]);
  runner('git', ['-C', checkoutRoot, 'config', 'user.name', 'github-actions[bot]']);
  runner('git', ['-C', checkoutRoot, 'config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  runner('git', ['-C', checkoutRoot, 'commit', '-m', `docs: sync for #${prNumber}`]);
  const remoteRef = `refs/heads/${headRef}`;
  runner('git', ['-C', checkoutRoot, 'push', `--force-with-lease=${remoteRef}:${headSha}`, 'origin', `HEAD:${remoteRef}`]);
  return { pushed: true, changed: staged };
}

async function main() {
  const [stagingDir, mapPath, checkoutRoot] = process.argv.slice(2);
  if (!stagingDir || !mapPath || !checkoutRoot) throw new Error('usage: publish.mjs <staging-dir> <map.json> <pr-checkout>');
  await publishDocs({
    stagingDir: resolve(stagingDir), map: JSON.parse(readFileSync(mapPath, 'utf8')),
    artifact: JSON.parse(readFileSync(join(stagingDir, 'artifact.json'), 'utf8')),
    checkoutRoot: resolve(checkoutRoot), headSha: process.env.HEAD_SHA ?? '',
    headRef: process.env.HEAD_REF ?? '', prNumber: process.env.PR ?? '',
    trustedRoot: resolve(fileURLToPath(new URL('../../', import.meta.url))),
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
