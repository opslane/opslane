import test from 'node:test';
import assert from 'node:assert/strict';
import { scanContent, LEGACY_EXEMPT, checkDocsVoice } from '../check-docs-voice.mjs';

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
  const content = '```bash\necho "a — dash"\n```\n<!-- a comment — with a dash -->\n';
  assert.deepEqual(scanContent(content, { file: 'x.md' }), []);
});

test('voice-ok on the previous line exempts a quoted banned word', () => {
  const content = '<!-- voice-ok: discussing the banned word itself -->\nNever write "seamless" in docs.\nBut seamless here fails.\n';
  const v = scanContent(content, { file: 'x.md' });
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 3);
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

test('the real tree passes and the exemption list only shrinks', () => {
  assert.deepEqual(checkDocsVoice({ root: '.' }), []);
  assert.ok(LEGACY_EXEMPT.size <= 19, `exemption list grew to ${LEGACY_EXEMPT.size}; it may only shrink`);
});
