import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ClaimedJob, TokenUsage } from '../src/db.js';
import type { EvidenceBundle } from '../src/evidence/bundle.js';
import {
  askInquiryModel,
  INQUIRY_MODEL,
  INQUIRY_PROMPT_VERSION,
  runInquiry,
} from '../src/inquiry/job.js';
import type { InquiryDecisionKind } from '../src/inquiry/schema.js';
import { createHostReader } from '../src/harness/host-reader.js';

interface EvaluationCase {
  name: string;
  issueType: string;
  expected: InquiryDecisionKind;
  notes: string;
  evidence: EvidenceBundle;
}

interface EvaluationFixture {
  version: number;
  source: string;
  cases: EvaluationCase[];
}

interface EvaluationRow {
  name: string;
  issueType: string;
  expected: InquiryDecisionKind;
  decision: InquiryDecisionKind;
  reason: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
}

const FIXTURE_PATH = new URL('../src/inquiry/__fixtures__/production-set.json', import.meta.url);
const DECISIONS = new Set<InquiryDecisionKind>([
  'investigate', 'wait_for_more_evidence', 'do_not_pursue',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function loadCase(value: unknown, index: number): EvaluationCase {
  if (!isRecord(value)) throw new Error(`fixture case ${index} must be an object`);
  const name = value['name'];
  const issueType = value['issueType'];
  const expected = value['expected'];
  const notes = value['notes'];
  const evidence = value['evidence'];
  if (typeof name !== 'string' || name === '') throw new Error(`fixture case ${index} has no name`);
  if (typeof issueType !== 'string' || issueType === '') throw new Error(`fixture ${name} has no issueType`);
  if (typeof expected !== 'string' || !DECISIONS.has(expected as InquiryDecisionKind)) {
    throw new Error(`fixture ${name} has an invalid expected decision`);
  }
  if (typeof notes !== 'string' || !isRecord(evidence)) {
    throw new Error(`fixture ${name} is missing notes or evidence`);
  }
  const affectedUnits = evidence['affectedUnits'];
  const frames = evidence['frames'];
  if (typeof affectedUnits !== 'number' || affectedUnits <= 0 || !isRecord(frames)
    || typeof frames['sourceEventId'] !== 'string') {
    throw new Error(`fixture ${name} is not a bounded evidence bundle`);
  }
  return { name, issueType, expected: expected as InquiryDecisionKind, notes, evidence: evidence as unknown as EvidenceBundle };
}

async function loadFixture(): Promise<EvaluationFixture> {
  const parsed: unknown = JSON.parse(await readFile(FIXTURE_PATH, 'utf8'));
  if (!isRecord(parsed) || parsed['version'] !== 1 || typeof parsed['source'] !== 'string'
    || !Array.isArray(parsed['cases'])) {
    throw new Error('production-set.json must be a version-1 evaluation fixture');
  }
  const cases = parsed['cases'].map(loadCase);
  if (cases.length !== 6) throw new Error(`production set has ${cases.length} cases, want 6`);
  return { version: 1, source: parsed['source'], cases };
}

function syntheticJob(index: number): ClaimedJob {
  const suffix = String(index + 1).padStart(12, '0');
  return {
    id: `70000000-0000-4000-8000-${suffix}`,
    workerId: 'inquiry-eval',
    errorGroupId: `71000000-0000-4000-8000-${suffix}`,
    eventId: null,
    episodeId: `72000000-0000-4000-8000-${suffix}`,
    sourceId: null,
    projectId: '73000000-0000-4000-8000-000000000001',
    jobType: 'issue_inquiry',
    attempts: 0,
    guidance: null,
    leaseGeneration: '1',
    triggeredBy: 'human',
    sessionId: null,
  };
}

function markdownReport(fixture: EvaluationFixture, rows: EvaluationRow[]): string {
  const accepted = rows.filter((row) => row.decision === 'investigate').length;
  const falseNegatives = rows.filter((row) => (
    row.expected === 'investigate' && row.decision !== 'investigate'
  ));
  const lines = [
    '# Inquiry fixed-set evaluation',
    '',
    `- Model: \`${INQUIRY_MODEL}\``,
    `- Prompt version: ${INQUIRY_PROMPT_VERSION}`,
    `- Fixture: ${fixture.source}`,
    `- Acceptance: ${accepted}/${rows.length}`,
    `- Reversals against expected labels: ${rows.filter((row) => row.decision !== row.expected).length}`,
    `- Potential false negatives: ${falseNegatives.length}`,
    '',
    '| Case | Type | Expected | Decision | Input tokens | Output tokens | Cost USD | Latency ms | Reason |',
    '| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |',
    ...rows.map((row) => (
      `| ${row.name} | ${row.issueType} | ${row.expected} | ${row.decision} | `
      + `${row.inputTokens} | ${row.outputTokens} | ${row.costUsd.toFixed(4)} | ${row.latencyMs} | `
      + `${row.reason.replaceAll('|', '\\|').replaceAll('\n', ' ')} |`
    )),
    '',
    '## Rejections requiring human review',
    '',
    ...rows.filter((row) => row.decision !== 'investigate')
      .flatMap((row) => [`- **${row.name}** — ${row.decision}: ${row.reason}`, '']),
  ];
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const fixture = await loadFixture();
  if (process.argv.includes('--validate-only')) {
    console.log(`inquiry evaluation fixture: ${fixture.cases.length} cases — valid`);
    return;
  }
  const repoPathValue = process.env['INQUIRY_EVAL_REPO_PATH'];
  if (!repoPathValue) {
    throw new Error('INQUIRY_EVAL_REPO_PATH is required (checkout corresponding to the production snapshots)');
  }
  const repoPath = resolve(repoPathValue);
  const rows: EvaluationRow[] = [];
  for (const [index, entry] of fixture.cases.entries()) {
    let usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let costUsd = 0;
    const startedAt = Date.now();
    const decision = await runInquiry(syntheticJob(index), new AbortController().signal, {
      loadEvidence: async () => entry.evidence,
      // The eval runs against a trusted local checkout, so it reads on this
      // host rather than renting a machine per case. The seam now hands back a
      // reader, because production reads inside a sandbox.
      prepareRepository: async () => ({
        reader: createHostReader(repoPath),
        sandboxId: 'local-eval',
        createdAt: Date.now(),
        cleanup: async () => undefined,
      }),
      askModel: async (input) => {
        const result = await askInquiryModel(input);
        usage = result.usage;
        costUsd = result.costUsd;
        return result;
      },
      persist: async () => true,
      recordUsage: async () => undefined,
    });
    rows.push({
      name: entry.name,
      issueType: entry.issueType,
      expected: entry.expected,
      decision: decision.decision,
      reason: decision.reason,
      inputTokens: usage.input,
      outputTokens: usage.output,
      costUsd,
      latencyMs: Date.now() - startedAt,
    });
  }

  console.table(rows.map((row) => ({
    case: row.name,
    type: row.issueType,
    expected: row.expected,
    decision: row.decision,
    reason: row.reason,
    tokens: row.inputTokens + row.outputTokens,
    cost_usd: row.costUsd.toFixed(4),
    latency_ms: row.latencyMs,
  })));
  const report = markdownReport(fixture, rows);
  const outputIndex = process.argv.indexOf('--output');
  if (outputIndex >= 0) {
    const outputPath = process.argv[outputIndex + 1];
    if (!outputPath) throw new Error('--output requires a Markdown path');
    await writeFile(resolve(outputPath), report, 'utf8');
  } else {
    console.log(`\n${report}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
