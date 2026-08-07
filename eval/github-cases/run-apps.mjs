import { readFileSync, writeFileSync } from 'node:fs';
import { cloneAtBase } from './clone.mjs';
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

const cases = readFileSync(`${HERE}cases-apps.jsonl`,'utf8').trim().split('\n').map(l=>JSON.parse(l));
// An optional fix_sha would silently disable the leak check for exactly the
// case that omitted it.
const missing = cases.filter((c) => !c.fix_sha).map((c) => `${c.repo}#${c.issue}`);
if (missing.length > 0) {
  throw new Error(`Cases missing fix_sha, so the leak assertion cannot run: ${missing.join(', ')}`);
}

const only = process.argv[2] ? cases.filter(c => `${c.repo}#${c.issue}` === process.argv[2]) : cases.slice(0, Number(process.argv[3]||3));
const results = [];

for (const c of only) {
  const dir = cloneAtBase(`https://github.com/${c.repo}.git`, c.base_sha, c.fix_sha);
  const input = extract(c.issue_body, c.issue_title);
  // Retry transient API failures: a long sequential batch trips rate limits,
  // and an api_error scored as a miss makes the agent look worse than it is.
  let r;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      r = await investigateError(process.env.ANTHROPIC_API_KEY, input, dir, { globs: null });
    } catch (e) { r = { outcome: 'THREW', reason: String(e).slice(0,120) }; }
    if (r.adjudication || !/model|budget|reach/i.test(r.reason ?? '')) break;
    await new Promise((res) => setTimeout(res, 20000 * (attempt + 1)));
  }

  // cause_locations is a list: a fix often touches more than one file, so score
  // a hit if ANY citation names a file the real fix changed.
  const citations = (r.adjudication?.cause_locations ?? []).map(x => x.split(':')[0].replace(/^\.?\//,''));
  const cited = citations.join(' | ');
  const hit = citations.some(cit => cit && c.ground_truth.some(f => f === cit || f.endsWith('/'+cit) || cit.endsWith('/'+f)));
  results.push({ ...c, cited, hit, outcome: r.outcome, strength: r.adjudication?.evidence_strength,
                 candidates: r.adjudication?.candidates_considered?.length ?? 0, why: r.adjudication?.why_chain ?? [],
                 reasoning: r.adjudication?.reasoning });
  console.log(`\n${'='.repeat(76)}\n${c.repo}#${c.issue}  ${hit?'HIT ':'MISS'}  ${r.outcome}/${r.adjudication?.evidence_strength??'-'}`);
  console.log(`  issue    : ${c.issue_title.slice(0,72)}`);
  console.log(`  truth    : ${c.ground_truth.join(', ')}`);
  console.log(`  we said  : ${cited || '(none)'}`);
  console.log(`  candidates: ${results.at(-1).candidates}  | reason: ${r.reason ?? r.decisionReason ?? '-'}`);
  (r.adjudication?.why_chain ?? []).slice(0,4).forEach((w,i)=>console.log(`    ${i+1}. ${w}`));
}
const hits = results.filter(r=>r.hit).length;
const answered = results.filter(r=>r.strength).length;
console.log(`\n${'='.repeat(76)}`);
console.log(`ANSWERED: ${answered}/${results.length}   LOCATED THE FIXED FILE: ${hits}/${answered}`);
writeFileSync(`${HERE}results.json`, JSON.stringify(results, null, 1));
