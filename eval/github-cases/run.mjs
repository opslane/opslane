import { writeFileSync } from 'node:fs';
import { cloneAtBase } from './clone.mjs';
import { scoreCase, splitFor } from './score.mjs';
import { extract, isRetryableError, loadCases, printReport, selectCases, withRetries } from './harness.mjs';
const HERE = new URL('.', import.meta.url).pathname;
const W = `${HERE}../../packages/worker/dist`;
const { investigateError } = await import(`${W}/investigate.js`);
// Trace each case. `initTracing` is otherwise only called from the worker
// entrypoint, so every eval run so far emitted nothing at all — which is why a
// regression on this corpus had to be diagnosed from stdout after the fact
// instead of diffed against the run before it. A no-op without Langfuse keys.
const { initTracing, shutdownTracing, withJobTrace } = await import(`${W}/tracing.js`);
await initTracing();

const cases = loadCases(process.env.CASES ?? 'cases.jsonl');
const only = selectCases(cases, process.argv.slice(2));

const results = [];

for (const c of only) {
  const dir = cloneAtBase(`https://github.com/${c.repo}.git`, c.base_sha, c.fix_sha);
  const input = extract(c.issue_body, c.issue_title);

  // A transport failure on our side does NOT throw. runReadOnlyAgent catches it
  // and returns stop:'api_error', which investigateError turns into a
  // needs_more_context result. Retrying only on a thrown exception therefore
  // scored every rate limit as the agent refusing to answer.
  // The case id goes in as the job id, so a trace is findable by the case it ran.
  const caseId = `${c.repo}#${c.issue}`;
  const { result: r, costUsd } = await withRetries(
    async () => withJobTrace(caseId, String(c.issue), c.repo, async () => {
      try {
        return await investigateError(process.env.ANTHROPIC_API_KEY, input, dir);
      } catch (e) {
        return { outcome: 'THREW', reason: String(e).slice(0, 200) };
      }
    }),
    (x) => (x.outcome === 'THREW' && isRetryableError(x.reason)) || x.stop === 'api_error',
  );

  // The FIRST citation is the claim; the rest are advisory and unscored.
  const locations = r.adjudication?.cause_locations ?? [];
  const { hit, primary } = scoreCase(locations, c.ground_truth);
  const cited = locations.map((l) => (l.line ? `${l.path}:${l.line}` : l.path)).join(' | ');
  const candidates = r.adjudication?.candidates_considered?.length ?? 0;
  // Only the scored fields are kept. Spreading the whole case copied issue_body
  // back out, which left results.json mostly a duplicate of the corpus.
  results.push({
    repo: c.repo, issue: c.issue, ground_truth: c.ground_truth, split: splitFor(c.repo),
    hit, primary,
    answered: Boolean(r.adjudication?.evidence_strength),
    strength: r.adjudication?.evidence_strength ?? null,
    costUsd,
  });
  console.log(`\n${'='.repeat(76)}\n${c.repo}#${c.issue}  ${hit?'HIT ':'MISS'}  ${r.outcome}/${r.adjudication?.evidence_strength??'-'}`);
  console.log(`  issue    : ${c.issue_title.slice(0,72)}`);
  console.log(`  truth    : ${c.ground_truth.join(', ')}`);
  console.log(`  we said  : ${cited || '(none)'}`);
  console.log(`  candidates: ${candidates}  | reason: ${r.reason ?? r.decisionReason ?? '-'}`);
  (r.adjudication?.why_chain ?? []).slice(0,4).forEach((w,i)=>console.log(`    ${i+1}. ${w}`));
}

printReport(results, cases);
writeFileSync(`${HERE}results.json`, JSON.stringify(results, null, 1));
// Flush before exit; the span processor batches, so without this the last
// cases' traces are dropped on process teardown.
await shutdownTracing();
