<script lang="ts">
import type { AgentApproveInfo, AgentStepName, AgentStepStatus } from '../types/api';

const STEP_LABELS: Record<AgentStepName, string> = {
  approve: 'Approve this setup',
  install_sdk: 'Install the SDK',
  first_event: 'First event received',
  github: 'GitHub connected',
  slack: 'Slack digest connected',
  sourcemaps: 'Source maps uploading',
  mcp: 'Agent connected to Opslane',
	pull_request: 'Open a pull request',
};
const STEP_ORDER: AgentStepName[] = ['approve', 'install_sdk', 'first_event', 'github', 'slack', 'sourcemaps', 'mcp', 'pull_request'];

export function deriveChecklist(info: AgentApproveInfo) {
  const facts = info.facts;
  const steps = facts?.steps ?? {};
  const reported = (s: Exclude<AgentStepName, 'approve'>): AgentStepStatus => steps[s]?.status ?? 'pending';
  const note = (s: AgentStepName): string => (s === 'approve' ? '' : steps[s]?.note ?? '');
  const approveStatus: AgentStepStatus =
    info.status === 'failed' ? 'failed' : info.status === 'pending' || info.status === 'expired' ? 'running' : 'done';
  const status = (s: AgentStepName): AgentStepStatus => {
    switch (s) {
      case 'approve':
        return approveStatus;
      case 'first_event': {
        if (facts?.has_events) return 'done';
        const r = reported('first_event');
        if (r === 'failed' || r === 'skipped') return r;
        return reported('install_sdk') === 'done' ? 'running' : 'pending';
      }
      case 'github':
        return facts?.github_connected ? 'done' : reported(s);
      case 'slack':
        return facts?.slack_connected ? 'done' : reported(s);
      case 'sourcemaps':
        return facts?.sourcemaps_uploaded ? 'done' : reported(s);
      default:
        return reported(s);
    }
  };
  return STEP_ORDER.map((step) => ({ step, label: STEP_LABELS[step], status: status(step), note: note(step) }));
}
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { approveAgentSession, denyAgentSession, getAgentApproveInfo, getMe } from '../api';
import Button from '../components/ui/Button.vue';
import { safeUrl } from '../utils';
import { applyProjectSelection } from '../components/project-switcher';

type Phase = 'loading' | 'choose' | 'working' | 'progress' | 'denied' | 'error';

const route = useRoute();
const router = useRouter();
const sessionId = typeof route.params.id === 'string' ? route.params.id : '';

const info = ref<AgentApproveInfo | null>(null);
const choice = ref<string>('__new__');
const projectName = ref('');
const phase = ref<Phase>('loading');
const message = ref('');
const boundProjectId = ref('');
const navigationMessage = ref('');
const navigating = ref(false);
const pendingDestination = ref('');
let mounted = true;
let timer: ReturnType<typeof setInterval> | null = null;
let generation = 0;          // bumped on unmount and on terminal states; stale responses are discarded
let inFlight = false;        // one refresh at a time

const checklist = computed(() => (info.value ? deriveChecklist(info.value) : []));
const latestIssue = computed(() => {
  const safe = safeUrl(info.value?.facts?.latest_error_group_url ?? undefined);
  if (!safe || !boundProjectId.value) return undefined;
  const url = new URL(safe);
  url.searchParams.set('project_id', boundProjectId.value);
  return url.href;
});
const dashboardPath = computed(() => `/?project_id=${encodeURIComponent(boundProjectId.value)}`);
const TERMINAL = new Set(['failed', 'expired', 'completed']);

function stopPolling(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
function startPolling(): void {
  // A hidden tab holds its last state; polling resumes on the next visible tick.
  if (!timer) timer = setInterval(() => { if (!document.hidden) void refresh(); }, 3000);
}

function applyInfo(next: AgentApproveInfo): void {
  info.value = next;
  if (next.project_id) boundProjectId.value = next.project_id;
  switch (next.status) {
    case 'pending':
      if (phase.value === 'loading') {
        projectName.value = next.project_name ?? '';
        choice.value = next.suggested_project_id ?? '__new__';
      }
      phase.value = 'choose';
      startPolling();
      break;
    case 'failed':
      phase.value = 'denied';
      break;
    case 'expired':
      phase.value = 'error';
      message.value = 'This setup link has expired. Ask your agent to run setup again.';
      break;
    default:
      phase.value = 'progress';
      startPolling();
  }
  if (TERMINAL.has(next.status)) {
    stopPolling();
    generation++;
  }
}

async function refresh(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  const gen = generation;
  try {
    const next = await getAgentApproveInfo(sessionId);
    if (gen !== generation) return; // unmounted or terminal since this request started
    applyInfo(next);
  } catch (err: unknown) {
    if (gen !== generation) return;
    stopPolling();
    generation++;
    phase.value = 'error';
    message.value = err instanceof Error ? err.message : 'Could not load this setup request.';
  } finally {
    inFlight = false;
  }
}

onMounted(async () => {
  sessionStorage.removeItem('opslane_post_auth_path');
  await refresh();
});
onBeforeUnmount(() => { mounted = false; stopPolling(); generation++; });

async function openDestination(destination: string): Promise<void> {
  if (navigating.value || !boundProjectId.value) return;
  const url = new URL(destination, window.location.origin);
  url.searchParams.set('project_id', boundProjectId.value);
  // Keep the exact error route while the agent finishes. The normal router
  // guard still applies; only the authenticated server response updates its cache.
  pendingDestination.value = `${url.pathname}${url.search}${url.hash}`;
  navigating.value = true;
  navigationMessage.value = '';
  try {
    const me = await getMe();
    if (!mounted) return;
    if (!me.onboarding_complete) {
      localStorage.removeItem('opslane_onboarding_complete');
      navigationMessage.value = 'Your agent is still finishing setup. Stay here, then check again to open this page.';
      return;
    }
    localStorage.setItem('opslane_onboarding_complete', '1');
    const name = info.value?.projects.find((project) => project.id === boundProjectId.value)?.name
      ?? info.value?.project_name ?? '';
    applyProjectSelection(localStorage, { id: boundProjectId.value, name });
    await router.push(pendingDestination.value);
  } catch (err: unknown) {
    if (!mounted) return;
    navigationMessage.value = err instanceof Error ? err.message : 'Could not check setup status. Try again.';
  } finally {
    if (mounted) navigating.value = false;
  }
}

function beginAction(): number {
  stopPolling();
  phase.value = 'working';
  return ++generation; // A picker refresh begun before this action is stale.
}

function actionError(err: unknown, fallback: string): void {
  stopPolling();
  generation++;
  phase.value = 'error';
  message.value = err instanceof Error ? err.message : fallback;
}

async function approve(): Promise<void> {
  const gen = beginAction();
  try {
    const body = choice.value === '__new__' ? { project_name: projectName.value.trim() } : { existing_project_id: choice.value };
    const approved = await approveAgentSession(sessionId, body);
    if (gen !== generation) return;
    if (info.value) applyInfo({ ...info.value, status: 'provisioned', project_id: approved.project_id, project_name: approved.project_name });
    await refresh();
  } catch (err: unknown) {
    if (gen !== generation) return;
    actionError(err, 'Approval failed.');
  }
}

async function deny(): Promise<void> {
  const gen = beginAction();
  try {
    await denyAgentSession(sessionId);
    if (gen !== generation) return;
    if (info.value) applyInfo({ ...info.value, status: 'failed' });
  } catch (err: unknown) {
    if (gen !== generation) return;
    actionError(err, 'Could not decline.');
  }
}
</script>

<template>
  <div class="min-h-screen bg-background flex items-center justify-center px-6">
    <div class="max-w-lg w-full rounded-lg border border-border bg-surface p-8" data-testid="agent-approve">
      <p v-if="phase === 'loading'" class="text-sm text-muted">Loading setup request…</p>

      <template v-else-if="phase === 'choose' || phase === 'working'">
        <h1 class="text-lg font-medium text-text">Approve agent setup</h1>
        <p class="mt-3 text-sm text-muted">
          <strong class="text-text">{{ info?.agent_name || 'A coding agent' }}</strong>
          wants to set up Opslane<span v-if="info?.git_remote"> for <code class="break-all">{{ info?.git_remote }}</code></span>. It will do the steps below and stop only for what it cannot do alone.
        </p>
        <p class="mt-2 text-xs text-muted" data-testid="agent-approve-warning">
          Anyone can send this link. Approve only if you started this setup yourself a moment ago; approving hands the agent keys for the project you pick.
        </p>

        <fieldset class="mt-6 space-y-3" :disabled="phase === 'working'">
          <legend class="text-xs font-medium text-muted">Project</legend>
          <label class="flex items-start gap-3 rounded border border-border p-3">
            <input type="radio" name="agent-project" value="__new__" v-model="choice" class="mt-1" />
            <span class="flex-1">
              <span class="block text-sm text-text">Create a new project</span>
              <input
                id="agent-project-name"
                aria-label="New project name"
                v-model="projectName"
                :disabled="choice !== '__new__'"
                class="mt-2 w-full rounded border border-border bg-background px-3 py-2 text-sm text-text disabled:opacity-50"
                data-testid="agent-project-name"
              />
            </span>
          </label>
          <label v-for="p in info?.projects ?? []" :key="p.id" class="flex items-start gap-3 rounded border border-border p-3">
            <input type="radio" name="agent-project" :value="p.id" v-model="choice" class="mt-1" />
            <span class="flex-1">
              <span class="block text-sm text-text">Use <strong>{{ p.name }}</strong></span>
              <span v-if="p.github_repo" class="block text-xs text-muted">{{ p.github_repo }}<span v-if="p.id === info?.suggested_project_id"> · matches this repo</span></span>
            </span>
          </label>
        </fieldset>

        <p class="mt-4 text-xs text-muted">
          Approving mints an ingest key for the browser SDK, an API key for the agent's MCP connection, and a source-map upload key. All three are listed under Settings and can be revoked there.
        </p>
        <div class="mt-6 flex gap-3">
          <Button variant="primary" class="flex-1" :disabled="phase === 'working' || (choice === '__new__' && !projectName.trim())" data-testid="agent-approve-button" @click="approve">
            {{ phase === 'working' ? 'Working…' : 'Approve' }}
          </Button>
          <Button variant="ghost" :disabled="phase === 'working'" data-testid="agent-deny-button" @click="deny">Decline</Button>
        </div>
      </template>

      <template v-else-if="phase === 'progress'">
        <h1 class="text-lg font-medium text-text">{{ info?.status === 'completed' ? 'Opslane is set up' : 'Your agent is setting up Opslane' }}</h1>
        <p class="mt-2 text-sm text-muted">This page updates as the agent works. You can go back to your terminal.</p>
      </template>

      <template v-else-if="phase === 'denied'">
        <h1 class="text-lg font-medium text-text">Setup declined</h1>
        <p class="mt-3 text-sm text-muted">You declined this setup. The agent will stop.</p>
      </template>

      <template v-else>
        <h1 class="text-lg font-medium text-text">Agent setup</h1>
        <p class="mt-3 text-sm text-danger" v-text="message"></p>
        <router-link to="/" class="mt-6 inline-block text-sm text-accent hover:underline">Back to Opslane</router-link>
      </template>

      <ol v-if="phase === 'choose' || phase === 'working' || phase === 'progress' || phase === 'denied'" class="mt-6 space-y-3" data-testid="agent-checklist">
        <li v-for="item in checklist" :key="item.step" :data-testid="`step-${item.step}`" :data-status="item.status" class="flex items-start gap-3 text-sm">
          <span class="mt-0.5 inline-block h-4 w-4 rounded-full border"
            :class="{ 'bg-success border-success': item.status === 'done', 'border-accent animate-pulse': item.status === 'running', 'bg-danger border-danger': item.status === 'failed', 'border-border': item.status === 'pending' || item.status === 'skipped' }"
          ></span>
          <span class="flex-1">
            <span class="sr-only">{{ item.status }}: </span>
            <span class="text-text" :class="{ 'line-through text-muted': item.status === 'skipped' }">{{ item.label }}</span>
            <span v-if="item.note" class="block text-xs text-muted">{{ item.note }}</span>
          </span>
        </li>
      </ol>
      <a v-if="phase === 'progress' && latestIssue" :href="latestIssue" @click.prevent="openDestination(latestIssue)" class="mt-6 inline-block text-sm text-accent hover:underline" data-testid="agent-latest-issue">Open the test error</a>
      <Button v-if="phase === 'progress'" variant="secondary" class="mt-6" data-testid="agent-dashboard" :disabled="navigating || !boundProjectId" @click="openDestination(dashboardPath)">Open dashboard</Button>
      <div v-if="navigationMessage" class="mt-4" role="status">
        <p class="text-sm text-muted">{{ navigationMessage }}</p>
        <Button class="mt-2" variant="secondary" :disabled="navigating" data-testid="agent-navigation-retry" @click="openDestination(pendingDestination)">Check again</Button>
      </div>
    </div>
  </div>
</template>
