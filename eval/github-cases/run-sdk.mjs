// Baseline: the same cases through the Claude Agent SDK's own harness.
// It brings its own tools, loop and context management; we supply only the
// bug report and the repo at the pre-fix commit, and ask for one CAUSE line.
// Resolve the SDK from the workspace rather than a hardcoded store path.
const { query } = await import('@anthropic-ai/claude-agent-sdk');
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

const HERE = new URL('.', import.meta.url).pathname;
const CASE_FILE = process.env.CASES ?? 'cases-apps.jsonl';

function extract(body, title) {
  const errLine = body.match(/^.*\b(TypeError|ReferenceError|RangeError|SyntaxError|Error):.*$/m)?.[0]?.trim();
  const fences = [...body.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map(m => m[1]);
  const stackish = fences.find(f => /\bat\s+\S+\s*\(|\.js:\d+|\.ts:\d+/.test(f));
  return { errorMessage: errLine ?? title, stackTrace: (stackish ?? fences[0] ?? body).slice(0, 3000) };
}

const cases = readFileSync(`${HERE}${CASE_FILE}`,'utf8').trim().split('\n').map(l=>JSON.parse(l));
const only = process.argv[2] ? cases.filter(c => `${c.repo}#${c.issue}` === process.argv[2]) : cases.slice(0, Number(process.argv[3]||2));
mkdirSync('/tmp/opslane-gheval-repos', { recursive: true });

for (const c of only) {
  const dir = `/tmp/opslane-gheval-repos/${c.repo.replace('/','__')}-${c.base_sha.slice(0,8)}`;
  if (!existsSync(dir)) {
    execSync(`git clone -q --filter=blob:none --no-checkout https://github.com/${c.repo}.git ${dir} && cd ${dir} && git checkout -q ${c.base_sha}`, { stdio: 'pipe' });
  }
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
    for await (const msg of query({ prompt, options: { cwd: dir, permissionMode: 'bypassPermissions', maxTurns: 30 } })) {
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
