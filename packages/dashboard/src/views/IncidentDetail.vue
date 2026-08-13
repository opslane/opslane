<script setup lang="ts">
import { computed, defineAsyncComponent, ref, onMounted, onUnmounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import type { Incident, AffectedUser, SampleEvent } from '../types/api';
import { APIError, getIncident, getSampleEvent, getReplay, listAffectedUsers, triggerFix, resolveIncident, archiveIncident, unarchiveIncident, type ReplayRecording } from '../api';
import { getProjectId, safeUrl, formatDate, formatAbsolute } from '../utils';
import { kindBadge, fixControlsVisible } from '../components/incident-kind';
import EvidenceWell from '../components/evidence/EvidenceWell.vue';
// rrweb is ~194 KB. Loading it eagerly put it in the entry chunk on every
// route, including /login. The player only mounts when a replay exists, so
// keep it in an on-demand chunk shared with SessionDetail.
const ReplayPlayer = defineAsyncComponent(() => import('../components/ReplayPlayer.vue'));
import CodeBlock from '../components/CodeBlock.vue';
import StatusLabel from '../components/ui/StatusLabel.vue';
import TextareaField from '../components/ui/TextareaField.vue';
import Button from '../components/ui/Button.vue';
import IncidentConclusion from '../components/incidents/IncidentConclusion.vue';
import PrLinkCard from '../components/incidents/PrLinkCard.vue';
import AttemptReasonCard from '../components/incidents/AttemptReasonCard.vue';
import CandidateDiffCard from '../components/incidents/CandidateDiffCard.vue';
import IncidentLifecycle from '../components/incidents/IncidentLifecycle.vue';
import { formatBreadcrumb, getRequestContext } from '../components/sample-event';
import type { eventWithTime } from '@rrweb/types';
import { useSessionPlayback } from '../composables/useSessionPlayback';
import { incidentStatusRecipe } from '../status-recipes';

const route = useRoute();
const incidentId = route.params['id'] as string;
const incident = ref<Incident | null>(null);
const causeHidden = computed(() =>
  incident.value?.investigation_readiness === 'ineligible'
  || incident.value?.investigation_readiness === 'pending',
);
const loading = ref(true);
const error = ref<string | null>(null);
const projectId = ref('');
const replay = ref<ReplayRecording | null>(null);
const replayLoading = ref(false);
const replayError = ref<string | null>(null);
const sampleEvent = ref<SampleEvent | null>(null);
const sampleEventError = ref<string | null>(null);
const requestContext = computed(() => (
  sampleEvent.value ? getRequestContext(sampleEvent.value.context) : null
));
const breadcrumbs = computed(() => (
  sampleEvent.value?.breadcrumbs.flatMap((breadcrumb) => {
    const formatted = formatBreadcrumb(breadcrumb);
    return formatted ? [formatted] : [];
  }) ?? []
));

// Breadcrumb timestamps are client-supplied and only narrowed to string:
// format parseable ones like the rest of the view, show the raw value otherwise.
function formatBreadcrumbTime(timestamp: string): string {
  return Number.isNaN(Date.parse(timestamp)) ? timestamp : formatAbsolute(timestamp);
}

async function loadSampleEvent() {
  sampleEvent.value = null;
  sampleEventError.value = null;
  try {
    sampleEvent.value = await getSampleEvent(projectId.value, incidentId);
  } catch (e: unknown) {
    if (e instanceof APIError && e.status === 404) return;
    sampleEventError.value = e instanceof Error ? e.message : String(e);
  }
}

const pointerSessionId = computed(() => incident.value?.session_pointer?.session_id ?? '');
const pointerErrorAt = computed(() => incident.value?.session_pointer?.error_at);
const {
  state: sessionReplayState,
  events: sessionReplayEvents,
  seekMs: sessionReplaySeekMs,
  missingChunks: sessionMissingChunks,
  approximate: sessionReplayApproximate,
  pollAttempt: sessionPollAttempt,
  pollsRemaining: sessionPollsRemaining,
  terminalUnavailable: sessionTerminalUnavailable,
  error: sessionReplayError,
  stopPolling: stopSessionPolling,
} = useSessionPlayback(projectId, pointerSessionId, {
  errorAt: pointerErrorAt,
  windowed: true,
});

// Tabs
const activeTab = ref<'overview' | 'affected-users'>('overview');
const affectedUsers = ref<AffectedUser[]>([]);
const affectedUsersLoading = ref(false);
const affectedUsersLoaded = ref(false);

async function loadAffectedUsers() {
  if (affectedUsersLoaded.value || affectedUsersLoading.value) return;
  affectedUsersLoading.value = true;
  try {
    affectedUsers.value = await listAffectedUsers(projectId.value, incidentId);
    affectedUsersLoaded.value = true;
  } catch {
    // Non-fatal
  } finally {
    affectedUsersLoading.value = false;
  }
}

async function loadReplay() {
  const id = incident.value?.replay_id;
  if (incident.value?.session_pointer && !sessionTerminalUnavailable.value) return;
  if (!id || replay.value || replayLoading.value) return;
  replayLoading.value = true;
  replayError.value = null;
  try {
    replay.value = await getReplay(projectId.value, id);
  } catch (e: unknown) {
    replayError.value = e instanceof Error ? e.message : String(e);
  } finally {
    replayLoading.value = false;
  }
}

watch(sessionTerminalUnavailable, (unavailable) => {
  if (unavailable) void loadReplay();
});

// Find Fix form state
const guidance = ref('');
const fixLoading = ref(false);
const fixError = ref<string | null>(null);
let fixPollTimer: ReturnType<typeof setInterval> | null = null;
let fixPollCount = 0;
const fixTimedOut = ref(false);
const MAX_FIX_POLLS = 60; // 5 minutes at 5s intervals

async function handleTriggerFix() {
  if (fixLoading.value || !incident.value) return;
  fixLoading.value = true;
  fixError.value = null;
  fixTimedOut.value = false;
  try {
    await triggerFix(projectId.value, incidentId, guidance.value || undefined);
    incident.value = { ...incident.value, status: 'fixing' };
    startFixPolling();
  } catch (e: unknown) {
    fixError.value = e instanceof Error ? e.message : String(e);
  } finally {
    fixLoading.value = false;
  }
}

function startFixPolling() {
  if (fixPollTimer) return;
  fixPollCount = 0;
  fixPollTimer = setInterval(async () => {
    fixPollCount++;
    if (fixPollCount > MAX_FIX_POLLS) {
      stopFixPolling();
      fixTimedOut.value = true;
      return;
    }
    try {
      const updated = await getIncident(projectId.value, incidentId);
      incident.value = updated;
      void loadReplay();
      if (updated.status !== 'fixing') {
        stopFixPolling();
      }
    } catch {
      // Non-fatal
    }
  }, 5000);
}

function stopFixPolling() {
  if (fixPollTimer) {
    clearInterval(fixPollTimer);
    fixPollTimer = null;
  }
}

onUnmounted(() => {
  stopFixPolling();
  stopSessionPolling();
});

function switchTab(tab: 'overview' | 'affected-users') {
  activeTab.value = tab;
  if (tab === 'affected-users') {
    loadAffectedUsers();
  }
}

const actionLoading = ref(false);

function getActionFn(action: 'resolve' | 'archive' | 'unarchive') {
  switch (action) {
    case 'resolve': return resolveIncident;
    case 'archive': return archiveIncident;
    case 'unarchive': return unarchiveIncident;
  }
}

async function doAction(action: 'resolve' | 'archive' | 'unarchive') {
  if (!incident.value || actionLoading.value) return;
  actionLoading.value = true;
  try {
    incident.value = await getActionFn(action)(projectId.value, incidentId);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    error.value = `Action failed: ${msg}`;
  } finally {
    actionLoading.value = false;
  }
}

onMounted(async () => {
  projectId.value = getProjectId();
  if (!projectId.value) {
    error.value = 'No project configured. Set project_id in query params or localStorage.';
    loading.value = false;
    return;
  }

  try {
    incident.value = await getIncident(projectId.value, incidentId);
    if (incident.value.kind === 'error') {
      void loadSampleEvent();
    }
    void loadReplay();
    if (incident.value.status === 'fixing') {
      startFixPolling();
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    error.value = `Failed to load incident: ${msg}`;
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="incident-case mx-auto w-full max-w-[1180px] [container-type:inline-size]">
    <router-link to="/" class="inline-flex min-h-10 items-center text-sm font-medium text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
      &larr; Back to issues
    </router-link>

    <div v-if="loading" class="mt-4 text-muted">Loading incident...</div>

    <div
      v-else-if="error"
      class="mt-4 rounded-md bg-danger/10 border border-danger/20 p-4 text-sm text-danger"
    >
      <p v-text="error"></p>
    </div>

    <div v-else-if="!incident" class="mt-8 flex flex-col items-center justify-center py-16 text-center">
      <svg class="h-12 w-12 text-faint mb-4" aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
      </svg>
      <h3 class="text-sm font-medium text-text">Incident not found</h3>
      <p class="mt-1 text-sm text-muted">This incident may have been resolved or doesn't exist.</p>
      <router-link to="/" class="mt-4 text-accent hover:underline text-sm">Back to issues</router-link>
    </div>

    <div v-else class="mt-4 space-y-6">
      <!-- Header -->
      <div>
        <div class="flex items-start gap-3">
          <h2 class="text-xl font-semibold text-text flex-1" v-text="incident.title"></h2>
          <span
            class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap mt-1"
            :class="kindBadge(incident.kind, incident.adjudication_status).class"
            v-text="kindBadge(incident.kind, incident.adjudication_status).label"
          >
          </span>
          <span
            v-if="incident.impact_class"
            data-testid="impact-badge"
            class="inline-flex items-center rounded-full border border-accent/20 bg-accent/10 px-2.5 py-0.5 text-xs font-medium capitalize text-accent whitespace-nowrap mt-1"
            v-text="incident.impact_class"
          ></span>
          <StatusLabel
            :tone="incidentStatusRecipe(incident.status).tone"
            :label="incidentStatusRecipe(incident.status).label"
            class="mt-1"
          />
        </div>
        <div
          v-if="incident.adjudication_status === 'unchecked'"
          class="mt-3 p-3 bg-warning/10 border border-warning/20 border-l-2 border-l-warning rounded-lg text-sm text-warning"
        >
          The automated friction check for this detection could not complete
          (it exhausted its retries). It is shown for visibility only: it has
          no impact counts and cannot be fixed automatically.
        </div>
        <div class="mt-2 flex flex-wrap gap-4 text-sm text-muted">
          <span>{{ incident.occurrence_count }} occurrences</span>
          <span>{{ incident.affected_users_count }} users affected</span>
          <span>First seen {{ formatDate(incident.first_seen) }}</span>
          <span>Last seen {{ formatDate(incident.last_seen) }}</span>
          <span v-if="incident.confidence" class="text-faint">
            {{ incident.confidence }} confidence
          </span>
        </div>
        <div v-if="incident.environments?.length" class="mt-3 flex flex-wrap items-center gap-2">
          <span class="text-xs font-medium uppercase tracking-wide text-muted">Environments</span>
          <span
            v-for="environment in incident.environments"
            :key="environment.id"
            class="inline-flex items-center rounded-full border border-border bg-surface px-2.5 py-1 text-xs text-muted"
            :title="`Last seen ${formatAbsolute(environment.last_seen)}`"
          >
            {{ environment.name }} · {{ environment.occurrence_count }} · {{ formatDate(environment.last_seen) }}
          </span>
        </div>
      </div>

      <IncidentLifecycle :status="incident.status" />

      <!-- Actions -->
      <div class="flex items-center gap-2">
        <Button
          v-if="incident.status !== 'resolved' && incident.status !== 'archived'"
          variant="primary"
          :disabled="actionLoading"
          @click="doAction('resolve')"
        >
          Resolve
        </Button>
        <Button
          v-if="incident.status !== 'archived'"
          variant="secondary"
          :disabled="actionLoading"
          @click="doAction('archive')"
        >
          Archive
        </Button>
        <Button
          v-if="incident.status === 'archived'"
          variant="primary"
          :disabled="actionLoading"
          @click="doAction('unarchive')"
        >
          Unarchive
        </Button>
      </div>

      <!-- Tabs -->
      <div class="border-b border-border pb-3">
        <nav class="flex gap-2">
          <button
            class="text-sm font-medium transition-colors"
            :class="activeTab === 'overview' ? 'border-b-2 border-accent px-3 py-2 text-text' : 'border-b-2 border-transparent px-3 py-2 text-muted hover:text-text'"
            @click="switchTab('overview')"
          >
            Overview
          </button>
          <button
            class="text-sm font-medium transition-colors"
            :class="activeTab === 'affected-users' ? 'border-b-2 border-accent px-3 py-2 text-text' : 'border-b-2 border-transparent px-3 py-2 text-muted hover:text-text'"
            @click="switchTab('affected-users')"
          >
            Affected Users ({{ incident.affected_users_count }})
          </button>
        </nav>
      </div>

      <!-- Overview Tab -->
      <div
        v-if="activeTab === 'overview'"
        class="grid gap-7 [grid-template-areas:'conclusion'_'evidence'] @min-[936px]:grid-cols-[minmax(0,1fr)_360px] @min-[936px]:items-start @min-[936px]:[grid-template-areas:'evidence_conclusion']"
      >
        <IncidentConclusion
          :incident="incident"
          class="[grid-area:conclusion] @min-[936px]:sticky @min-[936px]:top-6"
        />
        <div class="min-w-0 space-y-6 [grid-area:evidence]">
        <section class="p-4 bg-surface border border-border rounded-lg">
          <h2 class="text-xs font-medium text-muted uppercase tracking-wide">What happened</h2>
          <p data-testid="story" class="mt-2 text-base leading-6 text-text" v-text="incident.story"></p>
        </section>

        <!-- Coverage-proven recordings, with the existing inline replay first. -->
        <section data-testid="recordings" class="p-4 bg-surface border border-border rounded-lg space-y-3">
          <h2 class="text-xs font-medium text-muted uppercase tracking-wide">Recordings</h2>
          <template v-if="incident.session_pointer || incident.replay_id">
          <template v-if="incident.session_pointer && !sessionTerminalUnavailable">
            <div v-if="sessionReplayState === 'loading'" class="text-sm text-muted">Loading replay...</div>
            <div v-else-if="sessionReplayState === 'processing'" class="rounded-md border border-warning/20 bg-warning/10 p-3 text-sm text-warning">
              Recording is processing. Checking again shortly (attempt {{ sessionPollAttempt }}/24, {{ sessionPollsRemaining }} remaining).
            </div>
            <div v-else-if="sessionReplayState === 'error'" class="text-sm text-danger">Replay unavailable: {{ sessionReplayError }}</div>
            <template v-else-if="sessionReplayState === 'ready' || sessionReplayState === 'partial'">
              <div v-if="sessionReplayState === 'partial'" class="text-sm text-warning">
                {{ sessionMissingChunks.missing }} of {{ sessionMissingChunks.total }} chunks unavailable.
              </div>
              <div v-if="sessionReplayApproximate" class="text-sm text-warning">Playback position is approximate.</div>
              <ReplayPlayer :events="sessionReplayEvents" :crash-timestamp="sessionReplaySeekMs" />
              <router-link
                :to="{
                  name: 'session-detail',
                  params: { sessionId: incident.session_pointer.session_id },
                  query: { t: Date.parse(incident.session_pointer.error_at), project_id: projectId },
                }"
                class="inline-flex text-sm text-accent hover:underline"
              >Open full session &rarr;</router-link>
            </template>
          </template>
          <template v-else-if="incident.replay_id">
            <div v-if="replayLoading" class="text-sm text-muted">Loading replay...</div>
            <div v-else-if="replayError" class="text-sm text-danger">Replay unavailable: {{ replayError }}</div>
            <ReplayPlayer
              v-else-if="replay && replay.events && replay.events.length"
              :events="(replay.events as eventWithTime[])"
              :crash-timestamp="replay.meta?.crash_timestamp"
            />
            <div v-else class="text-sm text-muted">Replay recorded but empty.</div>
          </template>
          <div v-else class="text-sm text-muted">Session recording is no longer available.</div>
          </template>
          <p v-else-if="!incident.recordings?.length" class="text-sm text-faint">No replay captured for this error.</p>
          <div v-if="incident.recordings?.length" class="divide-y divide-border border-t border-border">
            <div
              v-for="recording in incident.recordings"
              :key="recording.session_id"
              class="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"
            >
              <div class="text-muted">
                <span>{{ formatAbsolute(recording.started_at) }}</span>
                <span class="mx-2" aria-hidden="true">·</span>
                <span>{{ Math.round(recording.duration_ms / 1000) }}s recorded</span>
                <span class="mx-2" aria-hidden="true">·</span>
                <span>{{ recording.crash_count }} {{ recording.crash_count === 1 ? 'crash' : 'crashes' }}</span>
              </div>
              <router-link
                :to="{
                  name: 'session-detail',
                  params: { sessionId: recording.session_id },
                  query: { t: recording.anchor_ms, project_id: projectId },
                }"
                class="font-medium text-accent hover:underline"
              >Watch</router-link>
            </div>
          </div>
        </section>

        <!-- Investigation results, including context preserved on drafts and needs_human -->
        <div
          v-if="causeHidden"
          class="p-4 bg-accent/10 border border-accent/20 border-l-2 border-l-accent rounded-lg space-y-3"
          data-testid="honest-state"
        >
          <h2 class="text-xs font-medium text-accent uppercase tracking-wide">Investigation</h2>
          <p class="text-sm">Investigation has not verified a cause yet.</p>
        </div>
        <div
          v-if="!causeHidden && (incident.status === 'investigated' || incident.status === 'insight' || incident.status === 'awaiting_approval' || incident.status === 'fixing' || incident.status === 'pr_draft' || incident.status === 'pr_created' || incident.status === 'needs_human') && (incident.root_cause || incident.agent_task_brief)"
          data-testid="root-cause"
          class="p-4 bg-accent/10 border border-accent/20 border-l-2 border-l-accent rounded-lg space-y-3"
        >
          <div v-if="incident.root_cause">
            <p class="text-xs font-medium text-accent uppercase tracking-wide">
              Root Cause
            </p>
            <pre
              class="mt-1 text-sm bg-surface border border-border p-3 rounded overflow-x-auto whitespace-pre-wrap text-text"
              v-text="incident.root_cause"
            ></pre>
          </div>
          <div v-if="incident.agent_task_brief" class="mt-4">
            <h3 class="text-xs font-medium text-accent uppercase tracking-wide">Investigation output — agent task brief</h3>
            <pre class="mt-1 whitespace-pre-wrap text-sm" v-text="incident.agent_task_brief"></pre>
          </div>
          <div v-if="incident.suggested_mitigation">
            <p class="text-xs font-medium text-accent uppercase tracking-wide">
              Suggested Fix
            </p>
            <pre
              class="mt-1 text-sm bg-surface border border-border p-3 rounded overflow-x-auto whitespace-pre-wrap text-text"
              v-text="incident.suggested_mitigation"
            ></pre>
          </div>
        </div>

        <!-- The fix receipt is a projection of stored readiness and artifacts. -->
        <section
          v-if="incident.receipt_state"
          data-testid="receipt"
          class="p-4 bg-surface border border-border rounded-lg space-y-4"
        >
          <div>
            <h2 class="text-xs font-medium text-muted uppercase tracking-wide">The fix</h2>
            <p data-testid="receipt-line" class="mt-2 text-sm font-medium text-text" v-text="incident.receipt_line"></p>
          </div>

          <PrLinkCard
            v-if="incident.receipt_state === 'pr_open' && incident.pr_url"
            :status="incident.status"
            :pr-url="incident.pr_url"
          />

          <CandidateDiffCard
            v-if="incident.receipt_state === 'attempt_failed_with_diff' && incident.candidate_diff"
            :diff="incident.candidate_diff"
          />

          <AttemptReasonCard
            v-if="(incident.receipt_state === 'attempt_failed_with_diff' || incident.receipt_state === 'attempt_failed_no_diff') && incident.reason"
            :reason="incident.reason"
          />
        </section>

        <!-- Artifact facts remain visible when readiness withholds receipt framing. -->
        <PrLinkCard
          v-if="!incident.receipt_state && incident.pr_url"
          :status="incident.status"
          :pr-url="incident.pr_url"
        />

        <CandidateDiffCard
          v-if="!incident.receipt_state && incident.status === 'needs_human' && incident.candidate_diff"
          :diff="incident.candidate_diff"
        />

        <AttemptReasonCard
          v-if="!incident.receipt_state && incident.status === 'needs_human' && incident.reason"
          :reason="incident.reason"
        />

        <!-- Representative error payload is forensic detail, below the receipt. -->
        <section
          v-if="sampleEvent || sampleEventError"
          data-testid="sample-event"
          class="p-4 bg-surface border border-border rounded-lg space-y-4"
        >
          <p v-if="sampleEventError" class="text-sm text-warning">Couldn't load stack trace.</p>
          <template v-if="sampleEvent">
            <div>
              <h3 class="text-xs font-medium text-muted uppercase tracking-wide">Stack trace</h3>
              <CodeBlock class="mt-2" :code="sampleEvent.error.stack" />
            </div>
            <div v-if="requestContext" class="space-y-2">
              <h3 class="text-xs font-medium text-muted uppercase tracking-wide">Request</h3>
              <dl class="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
                <div>
                  <dt class="text-muted">Method</dt>
                  <dd class="text-text" v-text="requestContext.method || '—'"></dd>
                </div>
                <div>
                  <dt class="text-muted">Path</dt>
                  <dd class="text-text font-mono text-xs" v-text="requestContext.path || '—'"></dd>
                </div>
                <div v-if="requestContext.remote_addr">
                  <dt class="text-muted">Client IP</dt>
                  <dd class="text-text font-mono text-xs" v-text="requestContext.remote_addr"></dd>
                </div>
              </dl>
              <details v-if="requestContext.headers" class="text-sm">
                <summary class="cursor-pointer text-muted">Headers</summary>
                <dl class="mt-2 space-y-1 rounded bg-surface-subtle p-3">
                  <div
                    v-for="header in requestContext.headers"
                    :key="header.name"
                    class="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3"
                  >
                    <dt class="font-mono text-xs text-muted" v-text="header.name"></dt>
                    <dd class="break-all font-mono text-xs text-text" v-text="header.value"></dd>
                  </div>
                </dl>
              </details>
            </div>
            <div v-if="breadcrumbs.length" class="space-y-2">
              <h3 class="text-xs font-medium text-muted uppercase tracking-wide">Breadcrumbs</h3>
              <ol class="space-y-2">
                <li
                  v-for="(breadcrumb, index) in breadcrumbs"
                  :key="`${breadcrumb.timestamp || 'breadcrumb'}-${index}`"
                  class="rounded border border-border p-3 text-sm"
                >
                  <div class="flex flex-wrap items-center gap-2 text-xs text-muted">
                    <time
                      v-if="breadcrumb.timestamp"
                      :datetime="breadcrumb.timestamp"
                      v-text="formatBreadcrumbTime(breadcrumb.timestamp)"
                    ></time>
                    <span
                      v-if="breadcrumb.label"
                      class="rounded-full bg-surface-subtle px-2 py-0.5 text-text"
                      v-text="breadcrumb.label"
                    ></span>
                    <span v-if="breadcrumb.level" v-text="breadcrumb.level"></span>
                  </div>
                  <p v-if="breadcrumb.message" class="mt-1 text-text" v-text="breadcrumb.message"></p>
                </li>
              </ol>
            </div>
          </template>
        </section>

        <!-- Insight card (no code cause — terminal, never a PR; design v4-4).
             Errors reach this status too, not just friction: an investigation
             that places the cause outside this codebase routes here, so the
             copy has to branch on kind rather than assume friction. -->
        <div
          v-if="incident.status === 'insight' && !causeHidden"
          class="p-4 bg-insight/10 border border-insight/20 border-l-2 border-l-insight rounded-lg space-y-3"
        >
          <p class="text-sm font-medium text-insight">Insight — no code cause</p>
          <p v-if="incident.kind === 'friction'" class="text-xs text-muted">
            Opslane investigated this friction and found no code change that would fix it.
            No PR will be created; use the findings below to guide a product or UX change.
          </p>
          <p v-else class="text-xs text-muted">
            Opslane traced this error to a cause outside the code it can change.
            No PR will be created; use the cause and remediation below to act on it where it lives.
          </p>
          <div v-if="incident.root_cause">
            <p class="text-xs font-medium text-insight uppercase tracking-wide">
              {{ incident.kind === 'friction' ? 'What users hit' : 'Cause' }}
            </p>
            <pre
              class="mt-1 text-sm bg-surface border border-border p-3 rounded overflow-x-auto whitespace-pre-wrap text-text"
              v-text="incident.root_cause"
            ></pre>
          </div>
        </div>

        <!-- Fix trigger: errors when investigated; friction only when a human
             approval is awaited (awaiting_approval). Insight, candidates, and
             unchecked diagnostics never render fix controls. -->
        <div
          v-if="fixControlsVisible(incident.kind, incident.status)"
          class="p-4 bg-surface border border-border rounded-lg space-y-3"
        >
          <p v-if="incident.status === 'awaiting_approval'" class="text-xs text-muted">
            This friction fix has a code cause and is waiting for your approval.
            It will open a <strong>Suggestion</strong> PR — repo tests must pass,
            but the friction itself is not re-verified.
          </p>
          <div>
            <TextareaField
              id="guidance"
              v-model="guidance"
              :rows="3"
              :maxlength="2000"
              label="Guide the agent (optional)"
              placeholder="Add context to help the agent find the right fix..."
            />
            <p class="mt-1 text-xs text-faint">{{ guidance.length }}/2000</p>
          </div>
          <div class="flex items-center gap-3">
            <Button
              :busy="fixLoading"
              variant="primary"
              @click="handleTriggerFix"
            >
              <span v-if="fixLoading">Triggering...</span>
              <span v-else>{{ incident.status === 'awaiting_approval' ? 'Generate fix' : 'Find Fix' }}</span>
            </Button>
            <p
              v-if="fixError"
              class="text-sm text-danger"
              v-text="fixError"
            ></p>
          </div>
        </div>

        <!-- Fixing indicator -->
        <div
          v-if="incident.status === 'fixing'"
          class="p-4 bg-progress/10 border border-progress/20 border-l-2 border-l-progress rounded-lg"
        >
          <div v-if="fixTimedOut">
            <p class="text-sm font-medium text-warning">This is taking longer than expected.</p>
            <p class="mt-1 text-xs text-warning">Refresh the page to check the latest status.</p>
          </div>
          <div v-else>
            <div class="flex items-center gap-2">
              <svg class="animate-spin h-4 w-4 text-progress" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <span class="text-sm font-medium text-progress">Agent is working on a fix...</span>
            </div>
            <p class="mt-1 text-xs text-progress">This page will update automatically when the fix is ready.</p>
          </div>
        </div>

        <EvidenceWell
          v-if="incident.verification_evidence"
          :evidence="incident.verification_evidence"
        />

        <!-- Metadata -->
        <div class="border-t border-border pt-4">
          <dl class="grid grid-cols-2 gap-x-8 gap-y-2 text-xs">
            <div>
              <dt class="text-muted">First seen</dt>
              <dd class="text-muted">{{ formatAbsolute(incident.first_seen) }}</dd>
            </div>
            <div>
              <dt class="text-muted">Last seen</dt>
              <dd class="text-muted">{{ formatAbsolute(incident.last_seen) }}</dd>
            </div>
            <div v-if="incident.merged_at">
              <dt class="text-muted">Merged</dt>
              <dd class="text-muted">{{ formatAbsolute(incident.merged_at) }}</dd>
            </div>
            <div v-if="incident.resolved_at">
              <dt class="text-muted">Resolved</dt>
              <dd class="text-muted">{{ formatAbsolute(incident.resolved_at) }}</dd>
            </div>
            <div v-if="incident.archived_at">
              <dt class="text-muted">Archived</dt>
              <dd class="text-muted">{{ formatAbsolute(incident.archived_at) }}</dd>
            </div>
            <div>
              <dt class="text-muted">Fingerprint</dt>
              <dd class="text-muted font-mono">{{ incident.fingerprint }}</dd>
            </div>
            <div>
              <dt class="text-muted">ID</dt>
              <dd class="text-muted font-mono">{{ incident.id }}</dd>
            </div>
            <div v-if="safeUrl(incident.trace_url)">
              <dt class="text-muted">Trace</dt>
              <dd>
                <a
                  :href="safeUrl(incident.trace_url)"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-accent hover:underline text-xs"
                >View in Langfuse</a>
              </dd>
            </div>
          </dl>
        </div>
        </div>
      </div>

      <!-- Affected Users Tab -->
      <div v-if="activeTab === 'affected-users'">
        <div v-if="affectedUsersLoading" class="text-muted text-sm">
          Loading affected users...
        </div>
        <div v-else-if="affectedUsers.length === 0" class="flex flex-col items-center justify-center py-12 text-center">
          <p class="text-sm text-muted">No affected users tracked for this incident.</p>
        </div>
        <div v-else class="border border-border rounded-lg overflow-hidden">
          <table class="min-w-full text-sm">
            <thead>
              <tr class="border-b border-border bg-surface">
                <th class="py-2.5 px-4 text-left text-xs font-medium text-muted uppercase tracking-wider">User ID</th>
                <th class="py-2.5 px-4 text-left text-xs font-medium text-muted uppercase tracking-wider">Email</th>
                <th class="py-2.5 px-4 text-left text-xs font-medium text-muted uppercase tracking-wider">Account</th>
                <th class="py-2.5 px-4 text-left text-xs font-medium text-muted uppercase tracking-wider">First seen</th>
                <th class="py-2.5 px-4 text-left text-xs font-medium text-muted uppercase tracking-wider">Last seen</th>
                <th class="py-2.5 px-4 text-right text-xs font-medium text-muted uppercase tracking-wider">Occurrences</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="user in affectedUsers"
                :key="user.end_user_id"
                class="border-b border-border hover:bg-surface transition-colors"
              >
                <td class="py-2.5 px-4 font-mono text-xs" v-text="user.external_user_id"></td>
                <td class="py-2.5 px-4" v-text="user.email || '—'"></td>
                <td class="py-2.5 px-4" v-text="user.external_account_id || '—'"></td>
                <td class="py-2.5 px-4 whitespace-nowrap">{{ formatDate(user.first_seen) }}</td>
                <td class="py-2.5 px-4 whitespace-nowrap">{{ formatDate(user.last_seen) }}</td>
                <td class="py-2.5 px-4 text-right tabular-nums">{{ user.occurrence_count }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>
