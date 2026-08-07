import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPLIT = JSON.parse(readFileSync(join(HERE, 'holdout.json'), 'utf8'));

/**
 * Score the FIRST citation only.
 *
 * The prompt asks for every file the fix is expected to touch, and the previous
 * scorer counted a hit when ANY citation matched ANY ground-truth file. Those
 * shipped in the same commit, so lengthening the list raised the expected score
 * without improving diagnosis.
 */
export function scoreCase(citations, groundTruth) {
  const primary = (citations[0] ?? '').split(':')[0].replace(/^\.?\//, '') || null;
  if (!primary) return { hit: false, primary: null };
  const hit = groundTruth.some((f) => f === primary || f.endsWith(`/${primary}`) || primary.endsWith(`/${f}`));
  return { hit, primary };
}

/** Which side of the frozen split a repository is on. Throws if unlisted. */
export function splitFor(repo) {
  if (SPLIT.tuning.includes(repo)) return 'tuning';
  if (SPLIT.holdout.includes(repo)) return 'holdout';
  throw new Error(`${repo} is not assigned in holdout.json; assign it before scoring against it`);
}

/**
 * Both denominators, the failure taxonomy, and cost. Never a bare score.
 *
 * `options.total` is the size of the full corpus, so a subset run says so in the
 * report body. A side log line saying SUBSET can be scrolled past; this cannot.
 */
export function report(results, options = {}) {
  const ran = results.length;
  const total = options.total ?? ran;
  const answered = results.filter((r) => r.answered).length;
  // A hit only counts from an answered run, or hits/answered can exceed 1.
  const hits = results.filter((r) => r.hit && r.answered).length;
  const insufficient = results.filter((r) => r.strength === 'insufficient').length;
  const noAdjudication = ran - answered;
  const cost = results.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);

  const lines = [];
  if (ran !== total) lines.push(`PARTIAL RUN: ${ran} of ${total} cases. This is not a corpus result.`);
  lines.push(
    `HIT RATE : ${hits}/${ran} of all cases, ${hits}/${answered} of answered`,
    `REFUSALS : insufficient: ${insufficient}  |  no adjudication: ${noAdjudication}`,
    `COST     : $${cost.toFixed(2)} across ${ran} runs, including retried attempts`,
  );
  return lines.join('\n');
}
