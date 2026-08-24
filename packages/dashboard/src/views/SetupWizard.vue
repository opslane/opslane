<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import {
  onboardingSetup,
  getEventStatus,
  getGitHubAppStatus,
  triggerSetupPR,
  getSetupPRStatus,
  setGitHubConfig,
} from '../api';
import type { GitHubAppStatus, SetupPrStatus } from '../types/api';
import { GITHUB_PR_URL_OPTIONS, safeUrl } from '../utils';
import CopyButton from '../components/CopyButton.vue';
import CodeBlock from '../components/CodeBlock.vue';
import RepoSelector from '../components/RepoSelector.vue';
import Button from '../components/ui/Button.vue';

const router = useRouter();

const step = ref(1);
const projectName = ref('');
const selectedRepo = ref('');
const projectId = ref('');
const apiKey = ref('');
const hasEvents = ref(false);
const error = ref('');
const loading = ref(false);

// GitHub App status
const githubAppStatus = ref<GitHubAppStatus | null>(null);
const loadingGitHub = ref(true);

// Step 4 setup PR state
const setupPr = ref<SetupPrStatus>({ status: '', pr_url: null, pr_number: null });
const setupPrHref = computed(() => safeUrl(setupPr.value.pr_url, GITHUB_PR_URL_OPTIONS));
const setupError = ref('');
const setupLoading = ref(false);
const setupTimer = ref<ReturnType<typeof setInterval>>();

// Step 5 polling
const pollInterval = ref<ReturnType<typeof setInterval>>();

const steps = [
  { num: 1, label: 'Connect GitHub' },
  { num: 2, label: 'Create project' },
  { num: 3, label: 'API key' },
  { num: 4, label: 'Install SDK' },
  { num: 5, label: 'Test it' },
];

onMounted(async () => {
  try {
    githubAppStatus.value = await getGitHubAppStatus();
    // Auto-advance if already installed
    if (githubAppStatus.value.installed) {
      step.value = 2;
    }
  } catch {
    // If we can't check status, skip to create project
    step.value = 2;
  } finally {
    loadingGitHub.value = false;
  }
});

async function submitProject(): Promise<void> {
  error.value = '';
  loading.value = true;
  try {
    const result = await onboardingSetup(projectName.value, selectedRepo.value);
    projectId.value = result.project.id;
    apiKey.value = result.api_key.raw_key;
    localStorage.setItem('opslane_project_id', result.project.id);
    localStorage.setItem('opslane_project_name', result.project.name);
    step.value = 3;
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Setup failed';
  } finally {
    loading.value = false;
  }
}

function keySaved(): void {
  step.value = 4;
  void openSetupPR();
}

function continueToTest(): void {
  step.value = 5;
  startPolling();
}

async function openSetupPR(): Promise<void> {
  if (!projectId.value) return;
  if (!selectedRepo.value) {
    setupPr.value = { status: 'failed', pr_url: null, pr_number: null, error: 'Choose a GitHub repository before opening the install PR.' };
    return;
  }

  setupError.value = '';
  setupLoading.value = true;
  setupPr.value = { status: 'pending', pr_url: null, pr_number: null };
  if (setupTimer.value) clearInterval(setupTimer.value);

  try {
    await setGitHubConfig(projectId.value, { github_repo: selectedRepo.value });
    await triggerSetupPR(projectId.value);
    await refreshSetupPR();
    setupTimer.value = setInterval(() => {
      void refreshSetupPR();
    }, 3000);
  } catch (err: unknown) {
    setupError.value = err instanceof Error ? err.message : 'Failed to open setup PR';
    setupPr.value = { status: 'failed', pr_url: null, pr_number: null, error: setupError.value };
  } finally {
    setupLoading.value = false;
  }
}

async function refreshSetupPR(): Promise<void> {
  if (!projectId.value) return;
  try {
    setupPr.value = await getSetupPRStatus(projectId.value);
    if (['open', 'already_installed', 'failed'].includes(setupPr.value.status) && setupTimer.value) {
      clearInterval(setupTimer.value);
      setupTimer.value = undefined;
    }
  } catch {
    // Non-fatal; keep polling.
  }
}

function startPolling(): void {
  if (pollInterval.value) clearInterval(pollInterval.value);
  pollInterval.value = setInterval(async () => {
    try {
      const status = await getEventStatus(projectId.value);
      if (status.has_events) {
        hasEvents.value = true;
        if (pollInterval.value) clearInterval(pollInterval.value);
      }
    } catch {
      // Non-fatal, keep polling
    }
  }, 3000);
}

onUnmounted(() => {
  if (pollInterval.value) clearInterval(pollInterval.value);
  if (setupTimer.value) clearInterval(setupTimer.value);
});

function goToDashboard(): void {
  router.push('/');
}

const viteEnvSnippet = computed(() => `VITE_OPSLANE_API_KEY=${apiKey.value}
VITE_OPSLANE_RELEASE=<your git SHA>`);
const testSnippet = `// Add this anywhere in your app to test:
throw new Error('Hello Opslane!');`;
</script>

<template>
  <div class="min-h-screen bg-background flex flex-col">
    <!-- Progress indicator -->
    <div class="bg-surface border-b border-border">
      <div class="max-w-2xl mx-auto px-6 py-4">
        <div class="flex items-center justify-between">
          <div
            v-for="(s, idx) in steps"
            :key="s.num"
            class="flex items-center"
            :class="idx < steps.length - 1 ? 'flex-1' : ''"
          >
            <div class="flex items-center">
              <div
                v-if="step > s.num"
                class="flex h-8 w-8 items-center justify-center rounded-full bg-accent"
              >
                <svg class="h-5 w-5 text-on-accent" viewBox="0 0 20 20" fill="currentColor">
                  <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
                </svg>
              </div>
              <div
                v-else-if="step === s.num"
                class="flex h-8 w-8 items-center justify-center rounded-full border-2 border-accent text-sm font-medium text-accent"
                v-text="s.num"
              ></div>
              <div
                v-else
                class="flex h-8 w-8 items-center justify-center rounded-full border-2 border-border text-sm font-medium text-faint"
                v-text="s.num"
              ></div>
              <span
                class="ml-2 text-sm font-medium hidden sm:inline"
                :class="step >= s.num ? 'text-text' : 'text-faint'"
                v-text="s.label"
              ></span>
            </div>
            <div
              v-if="idx < steps.length - 1"
              class="flex-1 mx-4 h-0.5"
              :class="step > s.num ? 'bg-accent' : 'bg-border'"
            ></div>
          </div>
        </div>
      </div>
    </div>

    <!-- Step content -->
    <div class="flex-1 flex items-start justify-center pt-12 pb-8">
      <div class="max-w-lg w-full mx-6">

        <!-- Step 1: Connect GitHub -->
        <div v-if="step === 1">
          <h1 class="text-2xl font-semibold text-text mb-2">Connect GitHub</h1>
          <p class="text-sm text-muted mb-6">
            Install the Opslane GitHub App to enable automated fix PRs.
          </p>

          <div v-if="loadingGitHub" class="text-sm text-muted">Checking GitHub status...</div>

          <div v-else-if="githubAppStatus?.installed" class="space-y-4">
            <div class="flex items-center gap-2">
              <span class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium bg-success/10 text-success">
                Connected
              </span>
              <span class="text-sm text-muted">GitHub App is installed</span>
            </div>
            <Button variant="primary" class="w-full" @click="step = 2">
              Continue
            </Button>
          </div>

          <div v-else class="space-y-4">
            <a
              v-if="githubAppStatus?.install_url"
              :href="safeUrl(githubAppStatus.install_url)"
              class="w-full flex items-center justify-center gap-3 rounded-md border border-border bg-surface px-4 py-3 text-sm font-medium text-text hover:bg-surface-subtle focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-background"
            >
              <svg class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path fill-rule="evenodd" d="M10 0C4.477 0 0 4.477 0 10c0 4.42 2.865 8.166 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.464-1.11-1.464-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.564 9.564 0 0110 4.844c.85.004 1.705.115 2.504.337 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C17.137 18.163 20 14.418 20 10c0-5.523-4.477-10-10-10z" clip-rule="evenodd" />
              </svg>
              Install GitHub App
            </a>

            <button
              @click="step = 2"
              class="w-full text-sm text-muted hover:text-text underline"
            >
              Skip for now
            </button>
          </div>
        </div>

        <!-- Step 2: Create project -->
        <div v-if="step === 2">
          <h1 class="text-2xl font-semibold text-text mb-2">Create your project</h1>
          <p class="text-sm text-muted mb-6">Set up your first project to start monitoring errors.</p>

          <form @submit.prevent="submitProject" class="space-y-4">
            <div>
              <label for="project-name" class="block text-sm font-medium text-muted">
                Project name
              </label>
              <input
                id="project-name"
                v-model="projectName"
                type="text"
                required
                autofocus
                :disabled="loading"
                placeholder="My App"
                class="mt-1 block w-full rounded-md border border-border bg-surface-subtle px-3 py-2 text-sm text-text focus:border-accent focus:ring-1 focus:ring-accent disabled:opacity-50"
              />
            </div>

            <div v-if="githubAppStatus?.installed">
              <label class="block text-sm font-medium text-muted">
                Repository
              </label>
              <div class="mt-1">
                <RepoSelector v-model="selectedRepo" />
              </div>
            </div>
            <div v-else>
              <label for="github-repo" class="block text-sm font-medium text-muted">
                GitHub repository
                <span class="text-faint font-normal">(optional)</span>
              </label>
              <input
                id="github-repo"
                v-model="selectedRepo"
                type="text"
                :disabled="loading"
                placeholder="owner/repo"
                class="mt-1 block w-full rounded-md border border-border bg-surface-subtle px-3 py-2 text-sm text-text focus:border-accent focus:ring-1 focus:ring-accent disabled:opacity-50"
              />
              <p class="mt-1 text-xs text-muted">Install the GitHub App in Settings to enable repo access.</p>
            </div>

            <div v-if="error" class="text-sm text-danger" v-text="error"></div>

            <Button variant="primary" class="w-full" type="submit" :disabled="loading || !projectName.trim()">
              {{ loading ? 'Creating...' : 'Create project' }}
            </Button>
          </form>
        </div>

        <!-- Step 3: API key -->
        <div v-if="step === 3">
          <h1 class="text-2xl font-semibold text-text mb-2">Your API key</h1>
          <p class="text-sm text-muted mb-6">Use this key to connect your application to Opslane.</p>

          <div class="rounded-lg bg-surface-subtle text-text p-4 font-mono text-sm break-all relative">
            <span v-text="apiKey"></span>
            <div class="absolute top-2 right-2">
              <CopyButton :text="apiKey" />
            </div>
          </div>

          <div class="mt-3 rounded-md bg-warning/10 border border-warning/20 p-3">
            <p class="text-sm text-warning">
              Save this key -- you won't see it again.
            </p>
          </div>

          <Button variant="primary" class="mt-6 w-full" @click="keySaved">
            I've saved my key
          </Button>
        </div>

        <!-- Step 4: Install SDK -->
        <div v-if="step === 4">
          <h1 class="text-2xl font-semibold text-text mb-2">Install the SDK</h1>
          <p class="text-sm text-muted mb-6">Opslane is opening a setup PR against your repository.</p>

          <div v-if="setupPr.status === 'pending' || setupPr.status === 'opening' || setupLoading" class="rounded-md border border-border bg-surface p-4">
            <div class="flex items-center gap-3 text-sm text-muted">
              <svg class="h-5 w-5 animate-spin text-accent" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              Opening your install PR...
            </div>
            <p class="mt-3 text-xs text-muted">This can take a few minutes while the agent edits and builds your app.</p>
          </div>

          <div v-else-if="setupPr.status === 'open'" class="space-y-4">
            <a
              v-if="setupPrHref"
              :href="setupPrHref"
              target="_blank"
              rel="noopener noreferrer"
              class="w-full flex items-center justify-center rounded-md bg-accent px-4 py-3 text-sm font-medium text-on-accent hover:bg-accent/90"
            >
              Review & merge install PR<span v-if="setupPr.pr_number">&nbsp;#{{ setupPr.pr_number }}</span>
            </a>

            <div class="rounded-md border border-warning/20 bg-warning/10 p-3">
              <p class="text-sm text-warning mb-2">Add this key as a build environment variable before deploying.</p>
              <CodeBlock :code="viteEnvSnippet" />
            </div>

            <Button variant="primary" class="w-full" @click="continueToTest">
              I've merged it
            </Button>
          </div>

          <div v-else-if="setupPr.status === 'already_installed'" class="space-y-4">
            <div class="rounded-md border border-success/20 bg-success/10 p-4 text-sm text-success">
              Opslane is already installed in this repository.
            </div>
            <Button variant="primary" class="w-full" @click="continueToTest">Send a test error</Button>
          </div>

          <div v-else class="space-y-4">
            <div class="rounded-md border border-danger/20 bg-danger/10 p-4">
              <p class="text-sm text-danger" v-text="setupPr.error || setupError || 'Opslane could not open the setup PR.'"></p>
            </div>
            <Button variant="primary" class="w-full" @click="openSetupPR">Retry</Button>
          </div>
        </div>

        <!-- Step 5: Test it -->
        <div v-if="step === 5">
          <h1 class="text-2xl font-semibold text-text mb-2">Test it!</h1>

          <div v-if="!hasEvents">
            <p class="text-sm text-muted mb-6">
              Trigger a test error in your app to verify the integration.
            </p>

            <CodeBlock :code="testSnippet" />

            <div class="mt-6 flex items-center gap-3 text-sm text-muted">
              <svg class="h-5 w-5 animate-spin text-accent" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              Waiting for your first event...
            </div>

            <button
              @click="goToDashboard"
              class="mt-6 text-sm text-muted hover:text-text underline"
            >
              Skip for now
            </button>
          </div>

          <div v-else class="text-center py-8">
            <svg class="h-16 w-16 text-success mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <h2 class="text-lg font-medium text-text">Event received!</h2>
            <p class="mt-1 text-sm text-muted">Your integration is working. Welcome to Opslane.</p>

            <Button variant="primary" class="mt-6" @click="goToDashboard">
              Go to dashboard
            </Button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
