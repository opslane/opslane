import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
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
const only = process.argv[2] ? cases.filter(c => `${c.repo}#${c.issue}` === process.argv[2]) : cases.slice(0, Number(process.argv[3]||3));
mkdirSync('/tmp/opslane-gheval-repos', { recursive: true });
const results = [];

for (const c of only) {
  const dir = `/tmp/opslane-gheval-repos/${c.repo.replace('/','__')}-${c.base_sha.slice(0,8)}`;
  if (!existsSync(dir)) {
    execSync(`git clone -q --filter=blob:none --no-checkout https://github.com/${c.repo}.git ${dir} && cd ${dir} && git checkout -q ${c.base_sha}`, { stdio: 'pipe' });
  }
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

  const cited = (r.adjudication?.cause_location ?? '').split(':')[0].replace(/^\.?\//,'');
  const hit = c.ground_truth.some(f => f === cited || f.endsWith('/'+cited) || cited.endsWith('/'+f));
  results.push({ ...c, cited, hit, outcome: r.outcome, strength: r.adjudication?.evidence_strength,
                 hypotheses: r.dossier?.hypotheses?.length ?? 0, why: r.adjudication?.why_chain ?? [],
                 reasoning: r.adjudication?.reasoning });
  console.log(`\n${'='.repeat(76)}\n${c.repo}#${c.issue}  ${hit?'HIT ':'MISS'}  ${r.outcome}/${r.adjudication?.evidence_strength??'-'}`);
  console.log(`  issue    : ${c.issue_title.slice(0,72)}`);
  console.log(`  truth    : ${c.ground_truth.join(', ')}`);
  console.log(`  we said  : ${r.adjudication?.cause_location ?? '(none)'}`);
  console.log(`  candidates: ${results.at(-1).hypotheses}  | reason: ${r.reason ?? r.decisionReason ?? '-'}`);
  (r.adjudication?.why_chain ?? []).slice(0,4).forEach((w,i)=>console.log(`    ${i+1}. ${w}`));
}
const hits = results.filter(r=>r.hit).length;
const answered = results.filter(r=>r.strength).length;
console.log(`\n${'='.repeat(76)}`);
console.log(`ANSWERED: ${answered}/${results.length}   LOCATED THE FIXED FILE: ${hits}/${answered}`);
writeFileSync(`${HERE}results.json`, JSON.stringify(results, null, 1));
