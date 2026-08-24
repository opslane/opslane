// check-docs-voice.mjs — the mechanical floor for docs voice.
//
// Scans published prose docs for the failure classes a machine can catch:
// em/en dashes outside typography carve-outs, banned marketing vocabulary,
// and unexplained project terminology.
// A jargon watchlist additionally applies to reader-facing setup pages
// (guides, quickstarts, install), where terms like "rollups" must be glossed
// or avoided. The judgment layer (jargon in context, comprehension) stays
// with the writer; this script only makes the floor unskippable.
//
// Carve-outs, deliberately narrow:
//   - fenced and inline code, plus HTML comments
//   - the list-item separator `- **Term** — text` / `- [link](url) — text`
//   - a line whose previous line is `<!-- voice-ok: reason -->` (for quoting
//     a banned word while discussing it)
//
// Legacy pages that predate the launch voice pass are exempt via
// LEGACY_EXEMPT below. Remove each entry when its audit issue lands; never
// add a new file to the list.

import { readFileSync } from 'node:fs';

import { checkDocsScope } from './check-docs-scope.mjs';

export const BANNED_VOCABULARY =
  /\b(proactive(?:ly)?|seamless(?:ly)?|robust(?:ly|ness)?|comprehensive(?:ly)?|leverag(?:e|ed|es|ing)|delv(?:e|es|ed|ing)|pivotal|crucial(?:ly)?|tapestry|game.chang(?:er|ing)|cutting.edge|streamlin(?:e|ed|es|ing)|empower(?:s|ed|ing)?|utiliz(?:e|ed|es|ing)|best practices|at its core|watershed|testament to)\b/i;

export const JARGON_WATCHLIST = /\b(rollups?|telemetry|posture|idempotent)\b/i;

// Keep these expressions out of customer prose. Matchers should stay narrow
// enough to leave ordinary uses of words such as "resolve" and "claim" alone.
// Exact identifiers remain available in inline code, and a voice-ok comment
// can exempt a deliberate use on the same or following line.
export const PROJECT_TERMINOLOGY = [
  ['friction', /\bfriction(?:\s+(?:issues?|fix(?:es)?|signals?))?\b/i],
  ['signal', /\bsignals?\b/i],
  ['triage', /\b(?:post[- ]?)?triag(?:e|ed|es|ing)\b/i],
  ['mint', /\bmint(?:s|ed|ing)?\b/i],
  ['stack resolution', /\bstack[- ]resolution\b/i],
  ['resolved stack', /\bresolved stacks?\b/i],
  [
    'source-map resolution',
    /(?:\b(?:source[- ]maps?|stack traces?|frames?)\b.{0,60}\b(?:resolv(?:e[sd]?|ing)|resolution)\b|\b(?:resolv(?:e[sd]?|ing)|resolution)\b.{0,60}\b(?:source[- ]maps?|stack traces?|frames?)\b)/i,
  ],
  ['observation', /\bobservations?\b/i],
  ['identity settlement', /\bidentity settlement\b/i],
  ['settles', /\bsettles?\b/i],
  ['inquiry', /\binquir(?:y|ies)\b/i],
  ['adjudication', /\badjudicat(?:e[sd]?|ing|ion)\b/i],
  ['evidence window', /\bevidence[- ]windows?\b/i],
  ['selector-only', /\bselector[- ]only\b/i],
  ['lease', /\bleas(?:e|es|ed|ing)\b/i],
  ['provisional', /\bprovisional\b/i],
  ['admitted issue', /\badmitted issues?\b/i],
  ['scrubbed', /\bscrub(?:s|bed|bing|bers?)\b/i],
  ['fingerprint', /\bfingerprint(?:s|ed|ing)?\b/i],
  ['product context', /\bproduct[- ]context\b/i],
  ['route map', /\broute[- ]maps?\b/i],
  ['issue round', /\bissue rounds?\b/i],
  ['reader-facing', /\breader[- ]facing\b/i],
  ['surface-observed', /\bsurface[- ]observed\b/i],
  ['re-redacted', /\bre[- ]redacted\b/i],
  ['fix judge', /\bfix judge\b/i],
  ['evidence-incomplete', /\bevidence[- ]incomplete\b/i],
  ['digest cards', /\bdigest cards?\b/i],
  ['candidate set', /\bcandidate sets?\b/i],
  ['receipt', /\breceipts?\b/i],
  ['ingestion component', /\bingestion\b/i],
  [
    'agent turns',
    /(?:\b(?:agent|model|tool)\s+turns?\b|\bturns?\s+(?:for|per|before|after)\s+(?:the\s+)?(?:agent|model|tool)\b|\bturns?\s+or\s+budget\b)/i,
  ],
  [
    'queue claim',
    /(?:\b(?:claim(?:s|ed|ing)?|claims-per-minute)\b.{0,50}\b(?:jobs?|queue|workers?)\b|\b(?:jobs?|queue|workers?)\b.{0,50}\bclaim(?:s|ed|ing)?\b)/i,
  ],
];

export const PROJECT_TERMINOLOGY_ALLOWLIST = new Map([
  ['docs/guides/friction.md', new Set(['friction', 'friction issue', 'signal'])],
]);

const JARGON_SCOPED_DIRS = [/^docs\/guides\//, /^docs\/quickstart\//, /^docs\/install\.md$/];

// The list-item separator carve-out: a bullet whose lead is bold or a link,
// followed by ` — ` as typography, not a prose splice.
const LIST_SEPARATOR = /^\s*[-*]\s+(\*\*[^*]+\*\*|\[[^\]]+\]\([^)]*\))\s+—\s/;

// Remove entries as their audit issues land (tracked on #345 / epic #2).
export const LEGACY_EXEMPT = new Set([
  // Measured on main, 2026-08-13. Each entry dies with its audit issue.
  'docs/contracts/action-scope.md',
  'docs/architecture/life-of-an-error.md',
  'docs/architecture/overview.md',
  'docs/contracts/events.md',
  'docs/contracts/reliability.md',
  'docs/quickstart/agent.md',
]);

function withoutInlineCode(text) {
  let prose = '';
  let cursor = 0;
  while (cursor < text.length) {
    if (text[cursor] !== '`') {
      prose += text[cursor];
      cursor += 1;
      continue;
    }

    let delimiterEnd = cursor;
    while (text[delimiterEnd] === '`') delimiterEnd += 1;
    const delimiter = text.slice(cursor, delimiterEnd);
    let closing = -1;
    let searchAt = delimiterEnd;
    while (searchAt < text.length) {
      const candidate = text.indexOf('`', searchAt);
      if (candidate === -1) break;
      let candidateEnd = candidate;
      while (text[candidateEnd] === '`') candidateEnd += 1;
      if (candidateEnd - candidate === delimiter.length) {
        closing = candidate;
        break;
      }
      searchAt = candidateEnd;
    }
    if (closing === -1) {
      prose += delimiter;
      cursor = delimiterEnd;
      continue;
    }

    prose += ' '.repeat(closing + delimiter.length - cursor);
    cursor = closing + delimiter.length;
  }
  return prose;
}

function projectTerminologyViolations(text, file, line, raw) {
  const allowlist = PROJECT_TERMINOLOGY_ALLOWLIST.get(file) ?? new Set();
  const violations = [];
  for (const [name, pattern] of PROJECT_TERMINOLOGY) {
    const match = text.match(pattern);
    if (!match) continue;
    const matchedText = match[0].toLowerCase();
    if (allowlist.has(name) || allowlist.has(matchedText)) continue;
    violations.push({
      file,
      line,
      rule: `project terminology: ${name}`,
      text: raw.trim().slice(0, 80),
    });
  }
  return violations;
}

export function scanContent(content, { jargon = false, file = '' } = {}) {
  const violations = [];
  // Frontmatter is metadata for the site and for docs-sync, not body prose.
  const body = content.startsWith('---\n')
    ? content.slice(content.indexOf('\n---', 3) + 4)
    : content;
  const offset = content.slice(0, content.length - body.length).split('\n').length - 1;
  const lines = body.split('\n');
  let inFence = false;
  let inComment = false;
  let prevAllows = false;

  lines.forEach((raw, i) => {
    const line = raw;
    const n = i + 1 + offset;
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

    const proseText = withoutInlineCode(text);
    const dashText = LIST_SEPARATOR.test(line) ? proseText.replace(/\s—\s/, ' ') : proseText;
    if (/[—–]/.test(dashText)) {
      violations.push({ file, line: n, rule: 'dash', text: line.trim().slice(0, 80) });
    }
    const vocab = proseText.match(BANNED_VOCABULARY);
    if (vocab) {
      violations.push({ file, line: n, rule: `vocabulary: ${vocab[1]}`, text: line.trim().slice(0, 80) });
    }
    if (jargon) {
      const j = proseText.match(JARGON_WATCHLIST);
      if (j) {
        violations.push({ file, line: n, rule: `jargon: ${j[1]}`, text: line.trim().slice(0, 80) });
      }
    }
    violations.push(...projectTerminologyViolations(proseText, file, n, line));
  });
  return violations;
}

export function checkDocsVoice({ root = '.' } = {}) {
  const targets = docsVoiceTargets({ root });
  const violations = [];
  for (const file of targets) {
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

export function docsVoiceTargets({ root = '.' } = {}) {
  return [...new Set([
    ...checkDocsScope({ root }).published,
    'docs-site/src/content/docs/index.mdx',
  ])];
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
  console.log('✓ docs voice: no dash, vocabulary, or project-terminology violations in published prose docs');
}
