import { readFileSync, writeFileSync } from 'node:fs';
import { cloneAtBase } from './clone.mjs';
import { report, scoreCase, splitFor } from './score.mjs';
const HERE = new URL('.', import.meta.url).pathname;
const W = `${HERE}../../packages/worker/dist`;
const { investigateError } = await import(`${W}/investigate.js`);

/** Pull an error line and any stack-shaped block out of an issue body. */
function extract(body, title) {
  const errLine = body.match(/^.*\b(TypeError|ReferenceError|RangeError|SyntaxError|Error):.*$/m)?.[0]?.trim();
  const fences = [...body.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map(m => m[1]);
  const stackish = fences.find(f => /\bat\s+\S+\s*\(|\.js:\d+|\.ts:\d+/.test(f));
  return {
    errorType: errLine?.match(/\b(\w*Error)\b/)?.[1] ?? 'BugReport',
    title,
    errorMessage: errLine ?? title,
    stackTrace: (stackish ?? fences[0] ?? body).slice(0, 3000),
    resolvedStackTrace: null,
    breadcrumbs: '[]',
  };
}

const cases = readFileSync(`${HERE}cases.jsonl`,'utf8').trim().split('\n').map(l=>JSON.parse(l));
// An optional fix_sha would silently disable the leak check for exactly the
// case that omitted it.
const missing = cases.filter((c) => !c.fix_sha).map((c) => `${c.repo}#${c.issue}`);
if (missing.length > 0) {
  throw new Error(`Cases missing fix_sha, so the leak assertion cannot run: ${missing.join(', ')}`);
}

// Default to the whole file. Defaulting to a subset made a 3-of-6 run print a
// summary indistinguishable from a full one.
const only = process.argv[2]
  ? cases.filter((c) => `${c.repo}#${c.issue}` === process.argv[2])
  : process.argv[3] ? cases.slice(0, Number(process.argv[3])) : cases;

// Both arms get the same policy: at most 3 attempts, retried ONLY on a
// transport or rate-limit failure, never on a substantive answer we dislike.
// Retrying on a substantive answer would let the harness resample until it
// liked the result. The LAST attempt supplies the answer; every attempt's cost
// is counted. Do not re-diverge this between run.mjs, run-apps.mjs and
// run-sdk.mjs: unequal retries are what made the last comparison unmatched.
const MAX_ATTEMPTS = 3;
const RETRYABLE = /rate.?limit|overloaded|429|5\d\d|ECONNRESET|ETIMEDOUT/i;

const results = [];

for (const c of only) {
  const dir = cloneAtBase(`https://github.com/${c.repo}.git`, c.base_sha, c.fix_sha);
  const input = extract(c.issue_body, c.issue_title);
  let attemptCost = 0;
  let r;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      r = await investigateError(process.env.ANTHROPIC_API_KEY, input, dir, { globs: null });
    } catch (e) {
      r = { outcome: 'THREW', reason: String(e).slice(0, 200) };
    }
    attemptCost += r.costUsd ?? 0;
    const transient = r.outcome === 'THREW' && RETRYABLE.test(r.reason ?? '');
    if (!transient || attempt === MAX_ATTEMPTS) break;
    await new Promise((res) => setTimeout(res, 20_000 * attempt));
  }

  // The FIRST citation is the claim; the rest are advisory and unscored.
  const { hit, primary } = scoreCase(r.adjudication?.cause_locations ?? [], c.ground_truth);
  const cited = (r.adjudication?.cause_locations ?? []).join(' | ');
  results.push({ ...c, cited, hit, primary, split: splitFor(c.repo),
                 outcome: r.outcome,
                 answered: Boolean(r.adjudication?.evidence_strength),
                 strength: r.adjudication?.evidence_strength ?? null,
                 costUsd: attemptCost,
                 candidates: r.adjudication?.candidates_considered?.length ?? 0,
                 why: r.adjudication?.why_chain ?? [],
                 reasoning: r.adjudication?.reasoning });
  console.log(`\n${'='.repeat(76)}\n${c.repo}#${c.issue}  ${hit?'HIT ':'MISS'}  ${r.outcome}/${r.adjudication?.evidence_strength??'-'}`);
  console.log(`  issue    : ${c.issue_title.slice(0,72)}`);
  console.log(`  truth    : ${c.ground_truth.join(', ')}`);
  console.log(`  we said  : ${cited || '(none)'}`);
  console.log(`  candidates: ${results.at(-1).candidates}  | reason: ${r.reason ?? r.decisionReason ?? '-'}`);
  (r.adjudication?.why_chain ?? []).slice(0,4).forEach((w,i)=>console.log(`    ${i+1}. ${w}`));
}
console.log(`\n${'='.repeat(76)}`);
console.log(report(results, { total: cases.length }));
const holdout = results.filter((x) => x.split === 'holdout');
console.log(`\n-- holdout only --`);
console.log(report(holdout, { total: holdout.length }));
writeFileSync(`${HERE}results.json`, JSON.stringify(results, null, 1));
