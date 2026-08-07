// Baseline: the same cases through the Claude Agent SDK's own harness.
// It brings its own tools, loop and context management; we supply only the
// bug report and the repo at the pre-fix commit, and ask for one CAUSE line.
// The SDK is a transitive dependency, so it has no top-level entry to resolve
// by name. Find it in the pnpm store instead.
import { execSync } from 'node:child_process';
const SDK_PATH = execSync(
  "find " + new URL('../../node_modules/.pnpm', import.meta.url).pathname +
  " -name sdk.mjs -path '*claude-agent-sdk*' | head -1", { encoding: 'utf8' }).trim();
if (!SDK_PATH) throw new Error('claude-agent-sdk not found in the workspace');
const { query } = await import(SDK_PATH);
import { cloneAtBase } from './clone.mjs';
import { scoreCase, splitFor } from './score.mjs';
import { extract, isRetryableError, loadCases, printReport, selectCases, withRetries } from './harness.mjs';

const cases = loadCases(process.env.CASES ?? 'cases-apps.jsonl');
const only = selectCases(cases, process.argv.slice(2));

const results = [];

for (const c of only) {
  const dir = cloneAtBase(`https://github.com/${c.repo}.git`, c.base_sha, c.fix_sha);
  const e = extract(c.issue_body, c.issue_title);

  const prompt = `A production bug was reported against this repository. Find its ROOT CAUSE.

## Bug report
Title: ${c.issue_title}
Error: ${e.errorMessage}

${e.stackTrace ? 'Details:\n' + e.stackTrace.slice(0,2000) : ''}

Read the code and work out where the cause actually lives. The code that observes
a failure is rarely the code that caused it.

When you are done, output exactly one final line and nothing after it:
CAUSE: <path/to/file.ts:line>`;

  const runOnce = async () => {
    let text = '', turns = 0, cost = 0;
    try {
      // READONLY=1 matches our harness's tool set so the comparison isolates the
      // loop rather than measuring what unrestricted bash buys. Note that
      // allowedTools does NOT constrain bypassPermissions -- that mode approves
      // every tool regardless -- so the restricted arm must not use it.
      const limits = process.env['READONLY'] === '1'
        ? {
            permissionMode: 'dontAsk',
            allowedTools: ['Read', 'Glob', 'Grep'],
            disallowedTools: ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task'],
          }
        : { permissionMode: 'bypassPermissions' };
      const maxTurns = Number(process.env['SDK_MAX_TURNS'] ?? 30);
      for await (const msg of query({ prompt, options: { cwd: dir, maxTurns, ...limits } })) {
        if (msg.type === 'assistant') { turns++; for (const b of msg.message.content) if (b.type === 'text') text += b.text; }
        if (msg.type === 'result') { cost = msg.total_cost_usd ?? 0; if (msg.result) text += '\n' + msg.result; }
      }
    } catch (err) {
      return { outcome: 'THREW', reason: String(err).slice(0, 200), text: '', turns, costUsd: cost };
    }
    return { outcome: 'ok', text, turns, costUsd: cost };
  };

  const t0 = Date.now();
  // No `stop` check here, unlike run.mjs: `runOnce` lets the SDK's transport
  // errors reach its catch, so a rate limit on this arm really does arrive as
  // THREW. Our arm swallows them into a stop reason instead, which is why it
  // needs the extra condition to retry on the same failures.
  const { result: r, costUsd: attemptCost } = await withRetries(
    runOnce,
    (x) => x.outcome === 'THREW' && isRetryableError(x.reason),
  );

  // The SDK emits one CAUSE line, so its primary citation is that line. Scored
  // through the same function as our arm, or the two are not comparable.
  const m = [...(r.text ?? '').matchAll(/CAUSE:\s*([^\s,)]+)/g)].pop();
  // The SDK emits one CAUSE line; wrap it in the same shape routing uses so
  // both arms are scored by the identical function.
  const causePath = (m?.[1] ?? '').split(':')[0];
  const { hit, primary } = scoreCase(causePath ? [{ path: causePath }] : [], c.ground_truth);
  results.push({
    repo: c.repo, issue: c.issue, split: splitFor(c.repo),
    hit, primary,
    // The SDK has no evidence gate, so "answered" is "it produced a citation".
    answered: Boolean(primary),
    strength: null,
    costUsd: attemptCost,
  });
  console.log(`\n${'='.repeat(70)}\n${c.repo}#${c.issue}  ${hit?'HIT ':'MISS'}  (${r.turns} turns, $${attemptCost.toFixed(3)}, ${((Date.now()-t0)/1000).toFixed(0)}s)`);
  console.log(`  truth   : ${c.ground_truth.join(', ')}`);
  console.log(`  sdk said: ${m?.[1] ?? '(no CAUSE line)'}`);
}

printReport(results, cases);
