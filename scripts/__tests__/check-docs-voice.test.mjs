import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scanContent,
  LEGACY_EXEMPT,
  checkDocsVoice,
  docsVoiceTargets,
} from '../check-docs-voice.mjs';

test('flags a prose em dash and an en dash', () => {
  const v = scanContent('The stack is up — mostly.\nA range of 5–10 items.\n', { file: 'x.md' });
  assert.equal(v.length, 2);
  assert.equal(v[0].rule, 'dash');
});

test('allows the bold-lead and link-lead list separators, flags a plain bullet splice', () => {
  const ok = '- **Term** — what it means\n- [Page](docs/page.md) — what it covers\n';
  assert.deepEqual(scanContent(ok, { file: 'x.md' }), []);
  const bad = '- a plain bullet — with a splice\n';
  assert.equal(scanContent(bad, { file: 'x.md' }).length, 1);
});

test('ignores code fences and HTML comments', () => {
  const content = '```bash\necho "mint a key — here"\n```\n<!-- a scrubber — comment -->\n';
  assert.deepEqual(scanContent(content, { file: 'x.md' }), []);
});

test('ignores project terminology in inline code', () => {
  const content =
    'Keep `mint-key`, `INGESTION_URL`, and `receipt` literal.\n' +
    'A ``code ` receipt`` also stays literal.\nMint a key in prose.\n';
  const v = scanContent(content, { file: 'x.md' });
  assert.equal(v.length, 1);
  assert.match(v[0].rule, /project terminology: mint/);
});

test('flags project terminology with careful word boundaries', () => {
  const content = 'The worker claimed a queue job.\nThe company claimed the result was correct.\n';
  const v = scanContent(content, { file: 'x.md' });
  assert.equal(v.length, 1);
  assert.equal(v[0].rule, 'project terminology: queue claim');
});

test('allows defined friction terms only in the friction guide', () => {
  const definition = 'A friction issue starts with a signal.\n';
  assert.deepEqual(scanContent(definition, { file: 'docs/guides/friction.md' }), []);
  assert.equal(scanContent(definition, { file: 'docs/install.md' }).length, 2);
});

test('voice-ok on the previous line exempts a quoted banned word', () => {
  const content = '<!-- voice-ok: discussing the banned word itself -->\nNever write "seamless" in docs.\nBut seamless here fails.\n';
  const v = scanContent(content, { file: 'x.md' });
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 3);
});

test('voice-ok exempts project terminology on the same or following line', () => {
  const content =
    '<!-- voice-ok: API uses this customer-visible name -->\nA receipt is returned.\n' +
    'A lease is documented. <!-- voice-ok: required queue term -->\n';
  assert.deepEqual(scanContent(content, { file: 'x.md' }), []);
});

test('vocabulary matches inflected forms', () => {
  const v = scanContent('We are leveraging robustness comprehensively.\n', { file: 'x.md' });
  assert.equal(v.length, 1);
  assert.match(v[0].rule, /vocabulary: leveraging/);
});

test('jargon watchlist fires only when enabled', () => {
  const content = 'Counts come from the rollups table.\n';
  assert.equal(scanContent(content, { file: 'x.md' }).length, 0);
  assert.equal(scanContent(content, { file: 'x.md', jargon: true }).length, 1);
});

test('derives targets from the published set and includes reference pages and the site index', () => {
  const targets = docsVoiceTargets({ root: '.' });
  assert.ok(targets.includes('docs/reference/environment-variables.md'));
  assert.ok(targets.includes('docs/reference/http-routes.md'));
  assert.ok(targets.includes('docs-site/src/content/docs/index.mdx'));
  assert.ok(!targets.includes('docs/reference/cli-agent-contract.md'));
});

test('the real tree passes and the exemption list only shrinks', () => {
  assert.deepEqual(checkDocsVoice({ root: '.' }), []);
  assert.ok(LEGACY_EXEMPT.size <= 15, `exemption list grew to ${LEGACY_EXEMPT.size}; it may only shrink`);
});
