import { Sandbox } from 'e2b';
import { buildQueryOptions, runReadOnlyAgentSdk, type ReadOnlyRunInput } from '../src/harness/sdk-agent.js';
import { createSandboxReader } from '../src/harness/readonly-sandbox.js';

const apiKey = process.env['ANTHROPIC_API_KEY']?.trim();
const template = process.env['OPSLANE_E2B_JAVASCRIPT_TEMPLATE']?.trim();
if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required');
if (!process.env['E2B_API_KEY']) throw new Error('E2B_API_KEY is required');
if (!template) throw new Error('OPSLANE_E2B_JAVASCRIPT_TEMPLATE is required');

const sandbox = await Sandbox.create(template, { timeoutMs: 300_000 });
try {
  await sandbox.commands.run(
    `mkdir -p /home/user/repo/src && printf 'export const answer = 42;\n' > /home/user/repo/src/answer.ts`,
  );
  const input: ReadOnlyRunInput = {
    apiKey,
    model: process.env['INVESTIGATION_MODEL'] ?? 'claude-sonnet-4-6',
    maxTurns: 4,
    budgetUsd: 0.10,
    pricing: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 },
    systemPrompt: 'Use only the supplied repository tools. Read the fixture and submit its numeric answer.',
    firstMessage: 'Find the exported answer in src/answer.ts and call submit_fixture.',
    reader: createSandboxReader(sandbox, '/home/user/repo'),
    terminalTool: {
      name: 'submit_fixture', description: 'Submit the fixture answer.',
      input_schema: {
        type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'],
      },
    },
    classification: { minFilesRead: 1 },
  };
  const options = buildQueryOptions(input);
  const forbidden = ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit', 'ToolSearch'];
  if (!Array.isArray(options.tools) || options.tools.length !== 0
      || forbidden.some((name) => options.allowedTools?.includes(name))) {
    throw new Error('A built-in tool is reachable in the SDK query options');
  }
  const result = await runReadOnlyAgentSdk(input);
  if (result.stop !== 'terminal' || result.terminalInput?.['answer'] !== 42) {
    throw new Error(`SDK tool verification failed: ${JSON.stringify(result)}`);
  }
  if (!result.filesRead.includes('src/answer.ts')) {
    throw new Error('The terminal completed without reading through the sandbox RepoReader');
  }
  console.log('PASS  built-in tools absent, sandbox reader used, terminal capture completed cleanly');
} finally {
  await sandbox.kill().catch(() => undefined);
}
