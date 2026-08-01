/**
 * Bridges eval cases to the worker's runAgentFix function.
 *
 * For eval, the bug patch is applied via setupCommands after the agent
 * clones the repo in E2B. The agent then fixes the bug and returns a diff.
 *
 * Requires: E2B_API_KEY + ANTHROPIC_API_KEY for real runs.
 * The eval app must be accessible via a git URL (repo_url in case.json).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runAgentFix, type AgentFixResult } from '../../packages/worker/src/agent-fix.js';
import type { EvalCase } from './types.js';

/**
 * Build a shell command that applies a patch via heredoc.
 * Uses base64 encoding to avoid shell escaping issues with patch content.
 */
function buildPatchCommand(patchContent: string): string {
  const b64 = Buffer.from(patchContent).toString('base64');
  return `echo '${b64}' | base64 -d | git apply --whitespace=fix`;
}


/**
 * The JS eval fixture repos declare `"build": "vite build"` but ship no
 * `index.html`, so `npm run build` fails with "Could not resolve entry module".
 * The harness treats a failing build as a failed fix, which means every
 * JavaScript case fails regardless of the agent or the crash report.
 *
 * Scaffold the missing entry after clone so the build gate measures the agent's
 * patch instead of a broken fixture. Idempotent and additive: it writes only
 * when the files are absent, and never touches a repo that already builds.
 * Remove this once the fixture repos carry their own entry point.
 */
function buildEntryScaffoldCommand(app: string): string {
  const isReact = app.includes('react');
  const mount = isReact
    ? [
        "import { createRoot } from 'react-dom/client';",
        "import App from './App';",
        "createRoot(document.getElementById('root')!).render(<App />);",
      ].join('\n')
    : [
        "import { createApp } from 'vue';",
        "import App from './App.vue';",
        "createApp(App).mount('#app');",
      ].join('\n');
  const entryFile = isReact ? 'src/main.tsx' : 'src/main.ts';
  const rootId = isReact ? 'root' : 'app';
  const html = [
    '<!doctype html>',
    '<html><body>',
    `<div id="${rootId}"></div>`,
    `<script type="module" src="/${entryFile}"></script>`,
    '</body></html>',
  ].join('\n');

  const htmlB64 = Buffer.from(html).toString('base64');
  const mountB64 = Buffer.from(mount).toString('base64');
  // Only create what is missing, so a fixture that gains a real entry later wins.
  return [
    `[ -f index.html ] || echo '${htmlB64}' | base64 -d > index.html`,
    `[ -f ${entryFile} ] || echo '${mountB64}' | base64 -d > ${entryFile}`,
  ].join(' && ');
}

function githubRepoFromUrl(repoUrl: string): string {
  const pathname = new URL(repoUrl).pathname.replace(/^\/|\/$/g, '').replace(/\.git$/, '');
  if (pathname.split('/').length !== 2) {
    throw new Error(`Eval repo_url must identify a GitHub owner/repository: ${repoUrl}`);
  }
  return pathname;
}

export async function callPipeline(
  evalCase: EvalCase,
  casesDir: string,
): Promise<AgentFixResult> {
  if (!evalCase.repo_url) {
    return {
      status: 'needs_human',
      reason: {
        reason_code: 'worker_runtime_error',
        reason_message: `Eval case ${evalCase.id} has no repo_url — cannot clone in E2B`,
        remediation: 'Add repo_url to case.json pointing to a GitHub repo containing the eval app',
      },
    };
  }

  // Build setup commands to apply the bug patch after clone+install
  const setupCommands: string[] = [];
  // Scaffold before the patch: the patch targets src/, never the entry.
  if (evalCase.error_event.platform !== 'python') {
    setupCommands.push(buildEntryScaffoldCommand(evalCase.app));
  }
  if (evalCase.bug_patch) {
    const patchPath = path.join(casesDir, evalCase.id, evalCase.bug_patch);
    const patchContent = await readFile(patchPath, 'utf-8');
    setupCommands.push(buildPatchCommand(patchContent));
  }

  return runAgentFix({
    platform: evalCase.error_event.platform,
    customerRuntime: evalCase.error_event.runtime ?? null,
    errorGroupId: evalCase.id,
    projectId: `eval-${evalCase.app}`,
    title: `${evalCase.error_event.error.type}: ${evalCase.error_event.error.message}`,
    errorType: evalCase.error_event.error.type,
    errorMessage: evalCase.error_event.error.message,
    stackTrace: evalCase.error_event.error.stack,
    resolvedStackTrace: null,
    breadcrumbs: JSON.stringify(evalCase.error_event.breadcrumbs),
    context: JSON.stringify(evalCase.error_event.context),
    sourceFiles: [],  // Agent reads files directly from repo
    visualAnalysis: null,
    repoUrl: evalCase.repo_url,
    githubRepo: githubRepoFromUrl(evalCase.repo_url),
    setupCommands: setupCommands.length > 0 ? setupCommands : undefined,
    budgetUsd: 2.00,  // Higher budget for eval cases
  });
}

export type { AgentFixResult };
