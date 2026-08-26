<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  completeOnboarding,
  createAPIKey,
  createNotificationDestination,
  getEventStatus,
  getGitHubAppStatus,
  getMe,
  getOnboardingState,
  listProjects,
  onboardingSetup,
  setGitHubConfig,
  testNotificationDestination,
  updateNotificationDestination,
  updateProject,
} from '../api';
import type { GitHubAppStatus, OnboardingState } from '../types/api';
import { GITHUB_PR_URL_OPTIONS, safeUrl } from '../utils';
import CodeBlock from '../components/CodeBlock.vue';
import RepoSelector from '../components/RepoSelector.vue';
import Button from '../components/ui/Button.vue';

type Step = 'create_project' | 'install_sdk' | 'connect_github' | 'connect_slack' | 'done';

const router = useRouter();
const step = ref<Step>('create_project');
const state = ref<OnboardingState | null>(null);
const projectId = ref('');
const apiKey = ref('');
const error = ref('');
const loading = ref(false);
const needsAdmin = ref(false);

const steps: Array<{ id: Exclude<Step, 'done'>; label: string }> = [
  { id: 'create_project', label: 'Create project' },
  { id: 'install_sdk', label: 'Install SDK' },
  { id: 'connect_github', label: 'Connect GitHub' },
  { id: 'connect_slack', label: 'Connect Slack' },
];
const activeStepNumber = computed(() => {
  if (step.value === 'done') return steps.length + 1;
  return steps.findIndex((candidate) => candidate.id === step.value) + 1;
});

async function restoreProjectStorage(): Promise<void> {
  try {
    const projects = await listProjects();
    const match = projects.find((project) => project.id === projectId.value) ?? projects[0];
    if (match) {
      localStorage.setItem('opslane_project_id', match.id);
      localStorage.setItem('opslane_project_name', match.name);
    }
  } catch {
    // App.vue also repairs project storage after navigation.
  }
}

onMounted(async () => {
  try {
    const me = await getMe();
    if (me.active_role === 'member') {
      needsAdmin.value = true;
      return;
    }
  } catch {
    // The authenticated state request below remains authoritative for entry.
  }

  try {
    const serverState = await getOnboardingState();
    state.value = serverState;
    projectId.value = serverState.project_id ?? '';
    if (projectId.value) await restoreProjectStorage();
    if (serverState.onboarding_complete) {
      localStorage.setItem('opslane_onboarding_complete', '1');
      await router.push('/');
      return;
    }
    if (serverState.next_step === 'done') {
      step.value = 'connect_slack';
      await finish();
      return;
    }
    step.value = serverState.next_step;
    if (step.value === 'install_sdk') await ensureKeyAndPoll();
    if (step.value === 'connect_github' && serverState.github_mode === 'app') {
      await loadGitHubStatus();
    }
  } catch (caught: unknown) {
    error.value = caught instanceof Error ? caught.message : 'Could not load onboarding state';
  }
});

const projectName = ref('');
const idempotencyToken = globalThis.crypto?.randomUUID?.()
  ?? `onboarding-${Date.now()}-${Math.random().toString(16).slice(2)}`;

async function submitProject(): Promise<void> {
  error.value = '';
  loading.value = true;
  try {
    const result = await onboardingSetup(projectName.value, idempotencyToken);
    projectId.value = result.project.id;
    apiKey.value = result.api_key.raw_key;
    localStorage.setItem('opslane_project_id', result.project.id);
    localStorage.setItem('opslane_project_name', result.project.name);
    step.value = 'install_sdk';
    startEventPolling();
  } catch (caught: unknown) {
    error.value = caught instanceof Error ? caught.message : 'Setup failed';
  } finally {
    loading.value = false;
  }
}

const framework = ref<'vue' | 'react' | 'nextjs' | 'other'>('vue');
const hasEvents = ref(false);
const latestGroupId = ref<string | null>(null);
const pollTimer = ref<ReturnType<typeof setInterval>>();
const keyError = ref('');
const keyLoading = ref(false);

const hostedOrigin = 'https://app.opslane.com';
const endpointLine = computed(() => (
  window.location.origin === hostedOrigin ? '' : `\n  endpoint: '${window.location.origin}',`
));
const initSnippet = computed(() => {
  const common = `init({\n  apiKey: '${apiKey.value}',\n  environment: 'development',${endpointLine.value}\n});`;
  switch (framework.value) {
    case 'vue':
      return `import { createApp } from 'vue';\nimport { init, opslaneVuePlugin } from '@opslane/sdk';\nimport App from './App.vue';\n\n${common}\n\ncreateApp(App).use(opslaneVuePlugin).mount('#app');`;
    case 'react':
      return `import { createRoot } from 'react-dom/client';\nimport { init } from '@opslane/sdk';\nimport { OpslaneErrorBoundary } from '@opslane/sdk/react';\nimport App from './App';\n\n${common}\n\ncreateRoot(document.getElementById('root')!).render(\n  <OpslaneErrorBoundary fallback={<p>Something went wrong.</p>}>\n    <App />\n  </OpslaneErrorBoundary>\n);`;
    case 'nextjs':
      return `// app/opslane-provider.tsx\n'use client';\nimport { useEffect } from 'react';\nimport { init } from '@opslane/sdk';\n\nexport function OpslaneProvider({ children }: { children: React.ReactNode }) {\n  useEffect(() => {\n    ${common.replace(/\n/g, '\n    ')}\n  }, []);\n  return <>{children}</>;\n}\n// Wrap {children} with <OpslaneProvider> in app/layout.tsx.`;
    default:
      return `import { init } from '@opslane/sdk';\n\n${common}`;
  }
});
const installSnippet = 'npm install @opslane/sdk';
const testButtonSnippet = computed(() => {
  switch (framework.value) {
    case 'vue':
      return `<button @click="() => { throw new Error('opslane-test') }">Test Opslane</button>`;
    case 'react':
    case 'nextjs':
      return `<button onClick={() => { throw new Error('opslane-test'); }}>Test Opslane</button>`;
    default:
      return `<button onclick="throw new Error('opslane-test')">Test Opslane</button>`;
  }
});

async function ensureKeyAndPoll(): Promise<void> {
  if (!apiKey.value && projectId.value) {
    keyError.value = '';
    keyLoading.value = true;
    try {
      const minted = await createAPIKey(projectId.value, {
        label: 'onboarding', expires_at: null, scope: 'ingest',
      });
      apiKey.value = minted.token;
    } catch (caught: unknown) {
      keyError.value = caught instanceof Error ? caught.message : 'Could not create an API key';
      return;
    } finally {
      keyLoading.value = false;
    }
  }
  if (apiKey.value) startEventPolling();
}

let pollInFlight = false;
function startEventPolling(): void {
  if (pollTimer.value) clearInterval(pollTimer.value);
  pollTimer.value = setInterval(async () => {
    if (pollInFlight || !projectId.value) return;
    pollInFlight = true;
    try {
      const status = await getEventStatus(projectId.value);
      if (status.has_events) {
        hasEvents.value = true;
        latestGroupId.value = status.latest_error_group_id;
        // Grouping is async: has_events flips before the error group exists.
        // Keep polling until the group id arrives so the success link points
        // at the captured error rather than degrading to the issues list.
        if (latestGroupId.value && pollTimer.value) clearInterval(pollTimer.value);
      }
    } catch {
      // Keep polling through transient errors.
    } finally {
      pollInFlight = false;
    }
  }, 3000);
}

async function continueFromSdk(): Promise<void> {
  step.value = 'connect_github';
  if (state.value?.github_mode !== 'pat') await loadGitHubStatus();
}

const githubAppStatus = ref<GitHubAppStatus | null>(null);
const patRepo = ref('');
const selectedRepo = ref('');
const githubError = ref('');
const githubBusy = ref(false);
const installHref = computed(() => safeUrl(
  githubAppStatus.value?.install_url ?? '', GITHUB_PR_URL_OPTIONS,
));

async function loadGitHubStatus(): Promise<void> {
  try {
    githubAppStatus.value = await getGitHubAppStatus();
  } catch {
    githubAppStatus.value = null;
  }
}

async function attachRepo(repo: string): Promise<void> {
  if (!repo.trim()) return;
  githubError.value = '';
  githubBusy.value = true;
  try {
    await setGitHubConfig(projectId.value, { github_repo: repo.trim() });
    window.dispatchEvent(new Event('opslane-integrations-changed'));
    if (state.value?.slack_connected) await finish();
    else step.value = 'connect_slack';
  } catch (caught: unknown) {
    githubError.value = caught instanceof Error ? caught.message : 'Could not connect the repository';
  } finally {
    githubBusy.value = false;
  }
}

function deferGitHub(): void {
  step.value = 'connect_slack';
}

const slackWebhookUrl = ref('');
const slackError = ref('');
const slackBusy = ref(false);
const slackDestId = ref('');
const digestTimezone = ref(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');

async function connectSlack(): Promise<void> {
  slackError.value = '';
  slackBusy.value = true;
  try {
    if (!slackDestId.value) {
      const created = await createNotificationDestination(projectId.value, {
        name: 'Daily digest',
        webhook_url: slackWebhookUrl.value,
        enabled: false,
        // No event_types: the server default subscribes both issue.created and
        // digest.daily, matching what Settings creates.
        delivery_policy: 'post_triage',
      });
      slackDestId.value = created.id;
    } else {
      await updateNotificationDestination(projectId.value, slackDestId.value, {
        webhook_url: slackWebhookUrl.value,
      });
    }
    const result = await testNotificationDestination(projectId.value, slackDestId.value, {
      eventType: 'issue.created',
    });
    if (!result.ok) {
      slackError.value = `We couldn't reach that webhook (${result.classification}). Check the URL and try again.`;
      return;
    }
    await updateNotificationDestination(projectId.value, slackDestId.value, { enabled: true });
    try {
      await updateProject(projectId.value, { digest_timezone: digestTimezone.value });
    } catch {
      // Timezone is best-effort and can be corrected in Settings.
    }
    window.dispatchEvent(new Event('opslane-integrations-changed'));
    await finish();
  } catch (caught: unknown) {
    slackError.value = caught instanceof Error ? caught.message : 'Could not connect Slack';
  } finally {
    slackBusy.value = false;
  }
}

async function deferSlack(): Promise<void> {
  await finish();
}

async function finish(): Promise<void> {
  error.value = '';
  try {
    await completeOnboarding();
    localStorage.setItem('opslane_onboarding_complete', '1');
    await restoreProjectStorage();
    step.value = 'done';
  } catch (caught: unknown) {
    error.value = caught instanceof Error ? caught.message : 'Could not complete setup';
  }
}

function goToDashboard(): void {
  void router.push('/');
}

onUnmounted(() => {
  if (pollTimer.value) clearInterval(pollTimer.value);
});
</script>

<template>
  <div class="min-h-screen bg-background flex flex-col">
    <div v-if="needsAdmin" class="flex min-h-screen items-center justify-center px-6">
      <div class="max-w-lg rounded-lg border border-border bg-surface p-8 text-center">
        <h1 class="text-2xl font-semibold text-text">Ask an organization admin to finish setup</h1>
        <p class="mt-3 text-sm text-muted">
          An admin needs to create the first project and integration credentials. You can return here after they finish.
        </p>
      </div>
    </div>

    <template v-else>
      <div class="border-b border-border bg-surface">
        <div class="mx-auto max-w-3xl px-6 py-4">
          <div class="flex items-center justify-between">
            <div
              v-for="(progressStep, index) in steps"
              :key="progressStep.id"
              class="flex items-center"
              :class="index < steps.length - 1 ? 'flex-1' : ''"
            >
              <div class="flex items-center">
                <div
                  class="flex h-8 w-8 items-center justify-center rounded-full border-2 text-sm font-medium"
                  :class="activeStepNumber > index + 1
                    ? 'border-accent bg-accent text-on-accent'
                    : activeStepNumber === index + 1
                      ? 'border-accent text-accent'
                      : 'border-border text-faint'"
                >
                  {{ activeStepNumber > index + 1 ? '✓' : index + 1 }}
                </div>
                <span
                  class="ml-2 hidden text-sm font-medium sm:inline"
                  :class="activeStepNumber >= index + 1 ? 'text-text' : 'text-faint'"
                >{{ progressStep.label }}</span>
              </div>
              <div
                v-if="index < steps.length - 1"
                class="mx-4 h-0.5 flex-1"
                :class="activeStepNumber > index + 1 ? 'bg-accent' : 'bg-border'"
              ></div>
            </div>
          </div>
        </div>
      </div>

      <div class="flex flex-1 items-start justify-center py-12">
        <div class="mx-6 w-full max-w-lg">
          <div v-if="error" class="mb-4 rounded-md border border-danger/30 bg-danger/10 p-3 text-sm text-danger" v-text="error"></div>

          <section v-if="step === 'create_project'">
            <h1 class="text-2xl font-semibold text-text">Create your project</h1>
            <p class="mt-2 text-sm text-muted">Name the app you want Opslane to monitor.</p>
            <form class="mt-6 space-y-4" @submit.prevent="submitProject">
              <div>
                <label for="project-name" class="block text-sm font-medium text-muted">Project name</label>
                <input
                  id="project-name"
                  v-model="projectName"
                  required
                  autofocus
                  :disabled="loading"
                  placeholder="My App"
                  class="mt-1 block w-full rounded-md border border-border bg-surface-subtle px-3 py-2 text-sm text-text"
                />
              </div>
              <Button type="submit" variant="primary" class="w-full" :busy="loading" :disabled="!projectName.trim()">
                Create project
              </Button>
            </form>
          </section>

          <section v-else-if="step === 'install_sdk'">
            <h1 class="text-2xl font-semibold text-text">Install the SDK</h1>
            <p class="mt-2 text-sm text-muted">Add Opslane, initialize it early, then throw one temporary test error.</p>

            <div v-if="keyError" class="mt-6 space-y-3">
              <p class="text-sm text-danger" v-text="keyError"></p>
              <Button data-testid="retry-mint" variant="primary" @click="ensureKeyAndPoll">Retry</Button>
            </div>
            <p v-else-if="keyLoading || !apiKey" class="mt-6 text-sm text-muted">Creating a browser ingest key…</p>
            <div v-else class="mt-6 space-y-5">
              <CodeBlock :code="installSnippet" />
              <div class="flex flex-wrap gap-2" role="tablist" aria-label="Framework">
                <button
                  v-for="option in ['vue', 'react', 'nextjs', 'other'] as const"
                  :key="option"
                  type="button"
                  class="rounded-md border px-3 py-1.5 text-sm capitalize"
                  :class="framework === option ? 'border-accent text-accent' : 'border-border text-muted'"
                  @click="framework = option"
                >{{ option === 'nextjs' ? 'Next.js' : option }}</button>
              </div>
              <CodeBlock :code="initSnippet" />
              <div>
                <p class="mb-2 text-sm text-muted">Temporarily add this button and click it:</p>
                <CodeBlock :code="testButtonSnippet" />
              </div>
              <div v-if="!hasEvents" class="flex items-center gap-3 rounded-md border border-border bg-surface p-4 text-sm text-muted">
                <span class="h-4 w-4 animate-spin rounded-full border-2 border-accent border-r-transparent"></span>
                Waiting for your first event…
              </div>
              <div v-else class="space-y-4 rounded-md border border-success/30 bg-success/10 p-4">
                <p class="text-sm text-success">Event received. View <a
                  data-testid="latest-group-link"
                  :href="latestGroupId ? '/issues/' + latestGroupId : '/'"
                  class="underline"
                >the latest error Opslane captured</a>.</p>
                <p class="text-xs text-muted">You can delete the test button now. Move the key to an environment variable before committing.</p>
                <Button data-testid="sdk-continue" variant="primary" @click="continueFromSdk">Continue</Button>
              </div>
            </div>
          </section>

          <section v-else-if="step === 'connect_github'">
            <h1 class="text-2xl font-semibold text-text">Connect GitHub</h1>
            <p class="mt-2 text-sm text-muted">Connect a repository so Opslane can open verified fix PRs.</p>
            <p v-if="githubError" class="mt-4 text-sm text-danger" v-text="githubError"></p>

            <form v-if="state?.github_mode === 'pat'" class="mt-6 space-y-4" @submit.prevent="attachRepo(patRepo)">
              <div>
                <label for="pat-repo" class="block text-sm font-medium text-muted">Repository</label>
                <input id="pat-repo" v-model="patRepo" required placeholder="owner/repo" class="mt-1 w-full rounded-md border border-border bg-surface-subtle px-3 py-2 text-sm text-text" />
              </div>
              <Button type="submit" variant="primary" class="w-full" :busy="githubBusy" :disabled="!patRepo.trim()">Connect repository</Button>
            </form>
            <div v-else class="mt-6 space-y-4">
              <a
                v-if="installHref && !githubAppStatus?.installed"
                :href="installHref"
                target="_blank"
                rel="noopener noreferrer"
                class="flex w-full items-center justify-center rounded-md bg-accent px-4 py-3 text-sm font-medium text-on-accent"
              >Install GitHub App</a>
              <Button v-if="!githubAppStatus?.installed" class="w-full" @click="loadGitHubStatus">Check again</Button>
              <div v-else class="space-y-3">
                <RepoSelector v-model="selectedRepo" :disabled="githubBusy" />
                <Button variant="primary" class="w-full" :busy="githubBusy" :disabled="!selectedRepo" @click="attachRepo(selectedRepo)">Connect repository</Button>
              </div>
              <p v-if="!githubAppStatus?.installed" class="text-xs text-muted">Waiting for GitHub? Ask an admin to approve the installation, or continue for now.</p>
            </div>
            <button data-testid="defer-github" type="button" class="mt-6 w-full text-sm text-muted underline hover:text-text" @click="deferGitHub">
              Do this later
            </button>
          </section>

          <section v-else-if="step === 'connect_slack'">
            <h1 class="text-2xl font-semibold text-text">Connect Slack</h1>
            <p class="mt-2 text-sm text-muted">Send your daily digest to a Slack channel.</p>
            <form data-testid="slack-connect" class="mt-6 space-y-4" @submit.prevent="connectSlack">
              <div>
                <label for="slack-webhook-url" class="block text-sm font-medium text-muted">Incoming webhook URL</label>
                <input id="slack-webhook-url" v-model="slackWebhookUrl" type="url" required placeholder="https://hooks.slack.com/services/…" class="mt-1 w-full rounded-md border border-border bg-surface-subtle px-3 py-2 text-sm text-text" />
                <a href="https://github.com/opslane/opslane/blob/main/docs/guides/slack-notifications.md" target="_blank" rel="noopener noreferrer" class="mt-1 inline-block text-xs text-accent underline">How to create a Slack webhook</a>
              </div>
              <div>
                <label for="digest-timezone" class="block text-sm font-medium text-muted">Digest timezone</label>
                <input id="digest-timezone" v-model="digestTimezone" class="mt-1 w-full rounded-md border border-border bg-surface-subtle px-3 py-2 text-sm text-text" />
              </div>
              <p v-if="slackError" class="text-sm text-danger" v-text="slackError"></p>
              <Button type="submit" variant="primary" class="w-full" :busy="slackBusy" :disabled="!slackWebhookUrl.trim()">Send test and connect</Button>
              <button data-testid="defer-slack" type="button" class="w-full text-sm text-muted underline hover:text-text" @click="deferSlack">
                Do this later
              </button>
            </form>
          </section>

          <section v-else class="py-8 text-center">
            <div class="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-success/10 text-2xl text-success">✓</div>
            <h1 class="mt-4 text-2xl font-semibold text-text">You are set up</h1>
            <p class="mt-2 text-sm text-muted">Opslane received your first event. Move the browser key to an environment variable before you commit.</p>
            <Button variant="primary" class="mt-6" @click="goToDashboard">Go to dashboard</Button>
          </section>
        </div>
      </div>
    </template>
  </div>
</template>
