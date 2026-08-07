// The parts every arm of the comparison must share.
//
// The retry policy in particular lives here and nowhere else: when it was
// copied into each runner the two arms drifted apart, and unequal retries are
// what made the last comparison unmatched.
import { readFileSync } from 'node:fs';
import { report, splitFor } from './score.mjs';

const HERE = new URL('.', import.meta.url).pathname;

/** Pull an error line and any stack-shaped block out of an issue body. */
export function extract(body, title) {
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

/** Load a case file, refusing one that cannot support the leak assertion. */
export function loadCases(file) {
  const cases = readFileSync(`${HERE}${file}`, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  // An optional fix_sha would silently disable the leak check for exactly the
  // case that omitted it.
  const missing = cases.filter((c) => !c.fix_sha).map((c) => `${c.repo}#${c.issue}`);
  if (missing.length > 0) {
    throw new Error(`Cases missing fix_sha, so the leak assertion cannot run: ${missing.join(', ')}`);
  }
  return cases;
}

/**
 * Which cases this invocation runs. `argv` is process.argv.slice(2): a
 * `repo#issue` selector, or a count.
 *
 * Defaults to the whole file. Defaulting to a subset made a 3-of-6 run print a
 * summary indistinguishable from a full one.
 */
export function selectCases(cases, argv) {
  if (argv[0]) return cases.filter((c) => `${c.repo}#${c.issue}` === argv[0]);
  if (argv[1]) return cases.slice(0, Number(argv[1]));
  return cases;
}

const MAX_ATTEMPTS = 3;
const RETRYABLE = /rate.?limit|overloaded|429|5\d\d|ECONNRESET|ETIMEDOUT/i;

/** Whether an error string names a transport or rate-limit failure. */
export function isRetryableError(text) {
  return RETRYABLE.test(text ?? '');
}

/**
 * At most 3 attempts, retried ONLY on a transport or rate-limit failure, never
 * on a substantive answer we dislike — retrying on one of those would let the
 * harness resample until it liked the result. The LAST attempt supplies the
 * answer; every attempt's cost is counted.
 *
 * `isTransient` differs per arm because the arms surface a rate limit
 * differently: the SDK lets it throw, while ours catches it and reports a stop
 * reason. The policy around it must not differ.
 */
export async function withRetries(run, isTransient) {
  let costUsd = 0;
  let result;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    result = await run(attempt);
    costUsd += result.costUsd ?? 0;
    if (!isTransient(result) || attempt === MAX_ATTEMPTS) break;
    await new Promise((res) => setTimeout(res, 20_000 * attempt));
  }
  return { result, costUsd };
}

/**
 * The corpus report and the holdout-only report.
 *
 * Both denominators come from the case file, not from what this run reached:
 * passing the reached count made a partial run print as a full one, which is
 * the exact defect the both-denominators report exists to prevent.
 */
export function printReport(results, cases) {
  console.log(`\n${'='.repeat(76)}`);
  console.log(report(results, { total: cases.length }));
  const holdout = results.filter((x) => x.split === 'holdout');
  const holdoutTotal = cases.filter((c) => splitFor(c.repo) === 'holdout').length;
  console.log(`\n-- holdout only --`);
  console.log(report(holdout, { total: holdoutTotal }));
}
