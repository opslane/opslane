import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { assertSecretFree, parsePorcelainZ, publishDocs } from '../docs-sync/publish.mjs';

const HEAD_SHA = 'b'.repeat(40);
const DOC = 'docs/guides/react.md';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function fixture(text = '# Edited\n') {
  const root = mkdtempSync(join(tmpdir(), 'docs-publish-test-'));
  const stagingDir = join(root, 'staging');
  const checkoutRoot = join(root, 'checkout');
  mkdirSync(join(stagingDir, dirname(DOC)), { recursive: true });
  mkdirSync(join(checkoutRoot, dirname(DOC)), { recursive: true });
  writeFileSync(join(stagingDir, DOC), text);
  writeFileSync(join(checkoutRoot, DOC), '# Original\n');
  return { stagingDir, checkoutRoot };
}

function inputs(paths = [DOC]) {
  return {
    map: { matched: [DOC] },
    artifact: { headSha: HEAD_SHA, changed: paths, secretFingerprints: [] },
    headSha: HEAD_SHA,
    headRef: 'feature/docs',
    prNumber: '42',
    snippetManifest: { version: 1, documents: { [DOC]: { fences: [] } } },
    stage2Validator: () => {},
    reportWarning: () => {},
  };
}

test('parsePorcelainZ is NUL-safe', () => {
  assert.deepEqual(parsePorcelainZ(` M ${DOC}\0?? docs/guides/new file.md\0`), [DOC, 'docs/guides/new file.md']);
});

test('generic token patterns fail while documentation placeholders pass', () => {
  assert.doesNotThrow(() => assertSecretFree('GITHUB_TOKEN=github_pat_...'));
  assert.throws(
    () => assertSecretFree('DEPLOY_TOKEN=actualSecretMaterial1234567890'),
    /secret pattern/,
  );
  assert.throws(() => assertSecretFree('AKIAABCDEFGHIJKLMNOP'), /secret pattern/);
});

test('an endpoint-bearing project key is refused, payload and all', () => {
  // vectors.valid[0].raw from test-fixtures/sourcemap-key/vectors.json.
  const canary =
    'opslane_sk_mzxw6ytboi3damrrgi3tknzxgq_E2ESOURCEMAPSECRETAAAAAAAAAAAAAAAAAAAAAAAAA'
    + '_eyJ2IjoxLCJpYXQiOiIyMDI2LTA4LTA0VDAwOjAwOjAwWiIsInVybCI6Imh0dHBzOi8vaW5nZXN0Lm9wc2xhbmUuY29tIn0';
  assert.throws(
    () => assertSecretFree(`Set \`OPSLANE_SOURCEMAP_KEY\` to ${canary} before building.\n`),
    /secret pattern/,
  );
  // The bare (legacy) form is still a secret and still refused.
  assert.throws(
    () => assertSecretFree('opslane_sk_mzxw6ytboi3damrrgi3tknzxgq_E2ESOURCEMAPSECRETAAAAAAAAAAAAAAAAAAAAAAAAA'),
    /secret pattern/,
  );
  // Prose about the key names is not a leak.
  assert.doesNotThrow(() => assertSecretFree('Set OPSLANE_SOURCEMAP_KEY to the opslane_sk_ value you minted.\n'));
});

test('guarded push pins the recorded head SHA', async () => {
  const dirs = fixture();
  const calls = [];
  const runner = (command, args) => {
    calls.push([command, ...args]);
    if (args.includes('status')) return ` M ${DOC}\0`;
    return '';
  };
  const result = await publishDocs({ ...dirs, ...inputs(), runner });
  assert.equal(result.pushed, true);
  assert.ok(calls.some((call) => call.includes(`--force-with-lease=refs/heads/feature/docs:${HEAD_SHA}`)));
  assert.ok(calls.some((call) => call.includes('HEAD:refs/heads/feature/docs')));
});

test('all edits are overlaid and Stage 2 passes before commit or push', async () => {
  const dirs = fixture();
  const second = 'docs/guides/vue.md';
  mkdirSync(join(dirs.stagingDir, dirname(second)), { recursive: true });
  mkdirSync(join(dirs.checkoutRoot, dirname(second)), { recursive: true });
  writeFileSync(join(dirs.stagingDir, second), '# Vue edited\n');
  writeFileSync(join(dirs.checkoutRoot, second), '# Vue original\n');
  const calls = [];
  const stage2Validator = ({ checkoutRoot }) => {
    calls.push(['stage2']);
    assert.equal(execFileSync('cat', [join(checkoutRoot, DOC)], { encoding: 'utf8' }), '# Edited\n');
    assert.equal(execFileSync('cat', [join(checkoutRoot, second)], { encoding: 'utf8' }), '# Vue edited\n');
    assert.equal(calls.some((call) => call.includes('commit') || call.includes('push')), false);
  };
  const runner = (command, args) => {
    calls.push([command, ...args]);
    if (args.includes('status')) return ` M ${DOC}\0 M ${second}\0`;
    return '';
  };
  const common = inputs([DOC, second]);
  common.map.matched.push(second);
  common.snippetManifest.documents[second] = { fences: [] };
  const result = await publishDocs({ ...dirs, ...common, stage2Validator, runner });
  assert.equal(result.pushed, true);
  assert.ok(calls.findIndex((call) => call[0] === 'stage2') < calls.findIndex((call) => call.includes('commit')));
});

test('Stage-1 and Stage-2 failures cannot commit or push', async () => {
  const stage1 = fixture();
  const stage1Calls = [];
  await assert.rejects(() => publishDocs({
    ...stage1,
    ...inputs(),
    contentValidator: () => { throw new Error('Stage 1 rejected'); },
    runner: (...args) => { stage1Calls.push(args); return ''; },
  }), /Stage 1 rejected/);
  assert.equal(execFileSync('cat', [join(stage1.checkoutRoot, DOC)], { encoding: 'utf8' }), '# Original\n');
  assert.equal(stage1Calls.length, 0);

  const stage2 = fixture();
  const stage2Calls = [];
  await assert.rejects(() => publishDocs({
    ...stage2,
    ...inputs(),
    stage2Validator: () => { throw new Error('Stage 2 rejected'); },
    runner: (command, args) => { stage2Calls.push([command, ...args]); return ''; },
  }), /Stage 2 rejected/);
  assert.equal(stage2Calls.some((call) => call.includes('commit') || call.includes('push')), false);
});

test('empty and idempotent artifacts do not commit or push', async () => {
  const root = mkdtempSync(join(tmpdir(), 'docs-publish-test-'));
  const calls = [];
  const empty = await publishDocs({ stagingDir: join(root, 'staging'), checkoutRoot: join(root, 'checkout'), ...inputs([]), runner: (...args) => { calls.push(args); return ''; } });
  assert.equal(empty.pushed, false);
  const dirs = fixture('# Original\n');
  const clean = await publishDocs({ ...dirs, ...inputs(), runner: (...args) => { calls.push(args); return ''; } });
  assert.equal(clean.reason, 'clean');
  assert.equal(calls.some(([, args]) => args?.includes?.('push')), false);
});

test('allowlist and secret failures happen before git side effects', async () => {
  const outside = fixture();
  const calls = [];
  await assert.rejects(() => publishDocs({ ...outside, ...inputs(), map: { matched: [] }, runner: (...args) => { calls.push(args); return ''; } }), /allowlist/);
  assert.equal(calls.length, 0);

  const secret = 'oauth-test-secret-value-123456';
  const dirs = fixture(`# leaked ${secret}\n`);
  const salt = 'a'.repeat(32);
  const secretFingerprints = [{ length: secret.length, salt, hmac: createHmac('sha256', salt).update(secret).digest('hex') }];
  await assert.rejects(() => publishDocs({ ...dirs, ...inputs(), artifact: { headSha: HEAD_SHA, changed: [DOC], secretFingerprints }, runner: (...args) => { calls.push(args); return ''; } }), /protected secret/);
  assert.equal(calls.length, 0);
});

test('symlinked PR destination is rejected before copy or git', async () => {
  const dirs = fixture();
  const target = join(dirs.checkoutRoot, 'elsewhere');
  mkdirSync(target);
  const guides = join(dirs.checkoutRoot, 'docs/guides');
  const { rmSync } = await import('node:fs');
  rmSync(guides, { recursive: true });
  symlinkSync(target, guides);
  let called = false;
  await assert.rejects(() => publishDocs({ ...dirs, ...inputs(), runner: () => { called = true; return ''; } }), /symlink/);
  assert.equal(called, false);
});

test('a real remote advance makes the guarded push fail without clobbering it', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'docs-publish-git-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, 'remote.git');
  const checkoutRoot = join(root, 'checkout');
  const other = join(root, 'other');
  const stagingDir = join(root, 'staging');

  git(root, 'init', '--bare', remote);
  git(root, 'init', checkoutRoot);
  git(checkoutRoot, 'config', 'user.name', 'test');
  git(checkoutRoot, 'config', 'user.email', 'test@example.com');
  mkdirSync(join(checkoutRoot, dirname(DOC)), { recursive: true });
  writeFileSync(join(checkoutRoot, DOC), '# Original\n');
  git(checkoutRoot, 'add', DOC);
  git(checkoutRoot, 'commit', '-m', 'initial');
  git(checkoutRoot, 'branch', '-M', 'feature/docs');
  git(checkoutRoot, 'remote', 'add', 'origin', remote);
  git(checkoutRoot, 'push', '-u', 'origin', 'feature/docs');
  const recordedHead = git(checkoutRoot, 'rev-parse', 'HEAD');

  git(root, 'clone', '--branch', 'feature/docs', remote, other);
  git(other, 'config', 'user.name', 'test');
  git(other, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(other, 'advanced.txt'), 'new remote commit\n');
  git(other, 'add', 'advanced.txt');
  git(other, 'commit', '-m', 'advance branch');
  git(other, 'push', 'origin', 'feature/docs');
  const advancedHead = git(other, 'rev-parse', 'HEAD');

  mkdirSync(join(stagingDir, dirname(DOC)), { recursive: true });
  writeFileSync(join(stagingDir, DOC), '# Edited by docs sync\n');
  await assert.rejects(
    () =>
      publishDocs({
        stagingDir,
        checkoutRoot,
        map: { matched: [DOC] },
        artifact: {
          headSha: recordedHead,
          changed: [DOC],
          secretFingerprints: [],
        },
        headSha: recordedHead,
        headRef: 'feature/docs',
        prNumber: '42',
        snippetManifest: { version: 1, documents: { [DOC]: { fences: [] } } },
        stage2Validator: () => {},
        reportWarning: () => {},
      }),
    /failed to push|stale info|fetch first/i,
  );
  assert.equal(git(root, '--git-dir', remote, 'rev-parse', 'refs/heads/feature/docs'), advancedHead);
});
