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
import { readFileSync } from 'node:fs';
import { cloneAtBase } from './clone.mjs';

const HERE = new URL('.', import.meta.url).pathname;
const CASE_FILE = process.env.CASES ?? 'cases-apps.jsonl';

function extract(body, title) {
  const errLine = body.match(/^.*\b(TypeError|ReferenceError|RangeError|SyntaxError|Error):.*$/m)?.[0]?.trim();
  const fences = [...body.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map(m => m[1]);
  const stackish = fences.find(f => /\bat\s+\S+\s*\(|\.js:\d+|\.ts:\d+/.test(f));
  return { errorMessage: errLine ?? title, stackTrace: (stackish ?? fences[0] ?? body).slice(0, 3000) };
}

const cases = readFileSync(`${HERE}${CASE_FILE}`,'utf8').trim().split('\n').map(l=>JSON.parse(l));
// An optional fix_sha would silently disable the leak check for exactly the
// case that omitted it.
const missing = cases.filter((c) => !c.fix_sha).map((c) => `${c.repo}#${c.issue}`);
if (missing.length > 0) {
  throw new Error(`Cases missing fix_sha, so the leak assertion cannot run: ${missing.join(', ')}`);
}

const only = process.argv[2] ? cases.filter(c => `${c.repo}#${c.issue}` === process.argv[2]) : cases.slice(0, Number(process.argv[3]||2));

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

  let text = '', turns = 0, cost = 0;
  const t0 = Date.now();
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
  } catch (err) { text = 'ERROR ' + String(err).slice(0,150); }

  const m = [...text.matchAll(/CAUSE:\s*([^\s,)]+)/g)].pop();
  const cited = (m?.[1] ?? '').split(':')[0].replace(/^\.?\//,'');
  const hit = cited && c.ground_truth.some(f => f === cited || f.endsWith('/'+cited) || cited.endsWith('/'+f));
  console.log(`\n${'='.repeat(70)}\n${c.repo}#${c.issue}  ${hit?'HIT ':'MISS'}  (${turns} turns, $${cost.toFixed(3)}, ${((Date.now()-t0)/1000).toFixed(0)}s)`);
  console.log(`  truth   : ${c.ground_truth.join(', ')}`);
  console.log(`  sdk said: ${m?.[1] ?? '(no CAUSE line)'}`);
}
