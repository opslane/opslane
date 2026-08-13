// check-docs-voice.mjs — the mechanical floor for docs voice.
//
// Scans published prose docs for the two failure classes a machine can catch:
// em/en dashes outside typography carve-outs, and a banned-vocabulary list.
// A jargon watchlist additionally applies to reader-facing setup pages
// (guides, quickstarts, install), where terms like "rollups" must be glossed
// or avoided. The judgment layer (jargon in context, comprehension) stays
// with the writer; this script only makes the floor unskippable.
//
// Carve-outs, deliberately narrow:
//   - fenced code blocks and HTML comments
//   - the list-item separator `- **Term** — text` / `- [link](url) — text`
//   - a line whose previous line is `<!-- voice-ok: reason -->` (for quoting
//     a banned word while discussing it)
//
// Legacy pages that predate the launch voice pass are exempt via
// LEGACY_EXEMPT below. Remove each entry when its audit issue lands; never
// add a new file to the list.

import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';

export const BANNED_VOCABULARY =
  /\b(proactive(?:ly)?|seamless(?:ly)?|robust(?:ly|ness)?|comprehensive(?:ly)?|leverag(?:e|ed|es|ing)|delv(?:e|es|ed|ing)|pivotal|crucial(?:ly)?|tapestry|game.chang(?:er|ing)|cutting.edge|streamlin(?:e|ed|es|ing)|empower(?:s|ed|ing)?|utiliz(?:e|ed|es|ing)|best practices|at its core|watershed|testament to)\b/i;

export const JARGON_WATCHLIST = /\b(rollups?|telemetry|posture|idempotent)\b/i;

const JARGON_SCOPED_DIRS = [/^docs\/guides\//, /^docs\/quickstart\//, /^docs\/install\.md$/];

// The list-item separator carve-out: a bullet whose lead is bold or a link,
// followed by ` — ` as typography, not a prose splice.
const LIST_SEPARATOR = /^\s*[-*]\s+(\*\*[^*]+\*\*|\[[^\]]+\]\([^)]*\))\s+—\s/;

// Remove entries as their audit issues land (tracked on #345 / epic #2).
export const LEGACY_EXEMPT = new Set([
  // Measured on main, 2026-08-13. #357 removes self-host; #358 removes index.mdx.
  'docs-site/src/content/docs/index.mdx',
  'docs/architecture/life-of-an-error.md',
  'docs/architecture/overview.md',
  'docs/architecture/precision.md',
  'docs/architecture/trust.md',
  'docs/contracts/action-scope.md',
  'docs/contracts/events.md',
  'docs/contracts/reliability.md',
  'docs/guides/github-app.md',
  'docs/guides/react.md',
  'docs/guides/replay-privacy.md',
  'docs/guides/slack-notifications.md',
  'docs/guides/source-maps.md',
  'docs/guides/source-maps-migration.md',
  'docs/guides/vanilla.md',
  'docs/guides/vue.md',
  'docs/install.md',
  'docs/quickstart/agent.md',
  'docs/quickstart/self-host.md',
]);

export function scanContent(content, { jargon = false, file = '' } = {}) {
  const violations = [];
  const lines = content.split('\n');
  let inFence = false;
  let inComment = false;
  let prevAllows = false;

  lines.forEach((raw, i) => {
    const line = raw;
    const n = i + 1;
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;

    // Walk the line and drop every commented span. A single pass with a
    // regex would leave a trailing unclosed `<!--` in the scanned text, so
    // this consumes openers and closers explicitly and carries the open
    // state to the next line.
    let text = '';
    let rest = line;
    while (rest.length > 0) {
      if (inComment) {
        const close = rest.indexOf('-->');
        if (close === -1) {
          rest = '';
          break;
        }
        rest = rest.slice(close + 3);
        inComment = false;
        continue;
      }
      const open = rest.indexOf('<!--');
      if (open === -1) {
        text += rest;
        break;
      }
      text += rest.slice(0, open);
      rest = rest.slice(open + 4);
      inComment = true;
    }

    const allowed = prevAllows;
    prevAllows = /<!--\s*voice-ok\b/.test(line);
    if (allowed || /<!--\s*voice-ok\b/.test(line)) return;

    const dashText = LIST_SEPARATOR.test(line) ? text.replace(/\s—\s/, ' ') : text;
    if (/[—–]/.test(dashText)) {
      violations.push({ file, line: n, rule: 'dash', text: line.trim().slice(0, 80) });
    }
    const vocab = text.match(BANNED_VOCABULARY);
    if (vocab) {
      violations.push({ file, line: n, rule: `vocabulary: ${vocab[1]}`, text: line.trim().slice(0, 80) });
    }
    if (jargon) {
      const j = text.match(JARGON_WATCHLIST);
      if (j) {
        violations.push({ file, line: n, rule: `jargon: ${j[1]}`, text: line.trim().slice(0, 80) });
      }
    }
  });
  return violations;
}

export function checkDocsVoice({ root = '.' } = {}) {
  const targets = [
    'README.md',
    'docs-site/src/content/docs/index.mdx',
    ...globSync('docs/{install.md,quickstart/*.md,guides/*.md,architecture/*.md,contracts/*.md}', { cwd: root }),
  ];
  const violations = [];
  for (const file of [...new Set(targets)]) {
    if (LEGACY_EXEMPT.has(file)) continue;
    let content;
    try {
      content = readFileSync(`${root}/${file}`, 'utf8');
    } catch {
      continue;
    }
    const jargon = JARGON_SCOPED_DIRS.some((re) => re.test(file));
    violations.push(...scanContent(content, { jargon, file }));
  }
  return violations;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const violations = checkDocsVoice({ root: process.cwd() });
  if (violations.length) {
    console.error(`✗ docs voice: ${violations.length} violation(s)`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line} [${v.rule}] ${v.text}`);
    }
    console.error(
      '  Fix the prose (see the full-voice-pass rules), or for a deliberate quote add <!-- voice-ok: reason --> on the previous line.',
    );
    process.exit(1);
  }
  console.log('✓ docs voice: no dash or vocabulary violations in non-exempt prose docs');
}
