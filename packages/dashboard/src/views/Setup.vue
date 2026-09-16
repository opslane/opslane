<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { completeOnboarding, getMe, getOnboardingState, listProjects } from '../api';
import type { OnboardingState } from '../types/api';
import AgentPasteBox from '../components/AgentPasteBox.vue';
import { applyProjectSelection } from '../components/project-switcher';
import Button from '../components/ui/Button.vue';

type Phase = 'loading' | 'account_error' | 'member' | 'setup' | 'completing' | 'complete_error' | 'entering' | 'enter_error';

const POLL_MS = 3000;

const router = useRouter();
const phase = ref<Phase>('loading');
const state = ref<OnboardingState | null>(null);
const stateFailed = ref(false);
const completeError = ref('');

const member = ref(false);
let polling = false;
let timer: ReturnType<typeof setTimeout> | undefined;
// Bumped on unmount and on every user retry. An awaited call whose
// generation is stale must not write storage or navigate: App.vue keys the
// route component on the active project, so this page can remount mid-request.
let generation = 0;

const statusLine = computed(() => {
  if (stateFailed.value) return 'Could not check setup status. Retrying.';
  const current = state.value;
  if (!current?.project_id) return 'Waiting for your agent. It will give you a link to approve.';
  if (!current.has_events) return 'Project ready. Waiting for the first event from your app.';
  return 'First event received. Opening your dashboard…';
});

function stopPolling(): void {
  polling = false;
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
}

function schedulePoll(): void {
  if (!polling) return;
  timer = setTimeout(() => { void poll(); }, POLL_MS);
}

async function loadAccount(): Promise<void> {
  stopPolling();
  const gen = ++generation;
  phase.value = 'loading';
  try {
    const me = await getMe();
    if (gen !== generation) return;
    // Completion is admin-only on cloud and the server fails closed on any role
    // it does not know, so only admin and owner may call it. Self-hosted reports
    // no role at all, and there everyone may complete.
    member.value = me.active_role !== undefined && me.active_role !== 'admin' && me.active_role !== 'owner';
  } catch {
    // An expired session never reaches here: the API client refreshes or
    // redirects to /login first.
    if (gen !== generation) return;
    phase.value = 'account_error';
    return;
  }
  polling = true;
  await poll();
}

async function poll(): Promise<void> {
  timer = undefined;
  const gen = generation;
  let next: OnboardingState;
  try {
    next = await getOnboardingState();
  } catch {
    if (gen !== generation || !polling) return;
    stateFailed.value = true;
    if (phase.value === 'loading') phase.value = member.value ? 'member' : 'setup';
    schedulePoll();
    return;
  }
  if (gen !== generation || !polling) return;
  state.value = next;
  stateFailed.value = false;

  if (next.onboarding_complete && next.project_id) {
    await enter();
    return;
  }
  if (member.value) {
    phase.value = 'member';
    schedulePoll();
    return;
  }
  phase.value = 'setup';
  if (next.has_events && !next.onboarding_complete) {
    await complete();
    return;
  }
  // Includes an onboarded org with no project: sending it to / would loop,
  // because App.vue routes a project-less org back to /setup.
  schedulePoll();
}

async function complete(): Promise<void> {
  stopPolling();
  const gen = generation;
  phase.value = 'completing';
  try {
    await completeOnboarding();
  } catch (err: unknown) {
    if (gen !== generation) return;
    completeError.value = err instanceof Error ? err.message : '';
    phase.value = 'complete_error';
    return;
  }
  if (gen !== generation) return;
  await enter();
}

async function enter(): Promise<void> {
  stopPolling();
  const gen = generation;
  phase.value = 'entering';
  let selected: { id: string; name: string } | undefined;
  try {
    const projects = await listProjects();
    if (gen !== generation) return;
    selected = projects.find((project) => project.id === state.value?.project_id) ?? projects[0];
  } catch {
    if (gen !== generation) return;
  }
  if (!selected) {
    phase.value = 'enter_error';
    return;
  }
  applyProjectSelection(localStorage, { id: selected.id, name: selected.name });
  localStorage.setItem('opslane_onboarding_complete', '1');
  await router.push('/');
}

function retryAccount(): void {
  void loadAccount();
}

function retryComplete(): void {
  generation++;
  void complete();
}

function retryEnter(): void {
  generation++;
  void enter();
}

onMounted(() => {
  void loadAccount();
});

onUnmounted(() => {
  generation++;
  stopPolling();
});
</script>

<template>
  <div class="min-h-screen bg-background flex items-start justify-center px-6 py-12">
    <p v-if="phase === 'loading'" class="text-sm text-muted" role="status">Loading…</p>

    <div v-else-if="phase === 'account_error'" class="w-full max-w-lg space-y-3" role="alert">
      <p class="text-sm text-danger">Could not load your account.</p>
      <Button data-testid="setup-retry-account" variant="primary" @click="retryAccount">Try again</Button>
    </div>

    <div v-else-if="member" class="max-w-lg rounded-lg border border-border bg-surface p-8 text-center" data-testid="setup-member">
      <h1 class="text-2xl font-semibold text-text">Ask an organization admin to finish setup</h1>
      <p class="mt-3 text-sm text-muted">An admin sets up Opslane with a coding agent. This page opens your dashboard when they finish.</p>
      <div v-if="phase === 'enter_error'" class="mt-6 space-y-3" role="alert">
        <p class="text-sm text-danger">Could not load your projects.</p>
        <Button data-testid="setup-retry-enter" variant="primary" @click="retryEnter">Try again</Button>
      </div>
    </div>

    <div v-else class="w-full max-w-lg">
      <h1 class="text-2xl font-semibold text-text">Set up Opslane with your coding agent</h1>
      <AgentPasteBox class="mt-6" />

      <div v-if="phase === 'complete_error'" class="mt-6 space-y-3" role="alert">
        <p class="text-sm text-danger">Could not finish setup.</p>
        <p v-if="completeError" class="text-sm text-danger" v-text="completeError"></p>
        <Button data-testid="setup-retry-complete" variant="primary" @click="retryComplete">Try again</Button>
      </div>
      <div v-else-if="phase === 'enter_error'" class="mt-6 space-y-3" role="alert">
        <p class="text-sm text-danger">Could not load your projects.</p>
        <Button data-testid="setup-retry-enter" variant="primary" @click="retryEnter">Try again</Button>
      </div>
      <p v-else class="mt-6 flex items-center gap-3 text-sm text-muted" role="status" data-testid="setup-status">
        <span class="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-accent border-r-transparent" aria-hidden="true"></span>
        <span>{{ statusLine }}</span>
      </p>
    </div>
  </div>
</template>
