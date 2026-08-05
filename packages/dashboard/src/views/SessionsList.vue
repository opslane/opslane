<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { listSessions } from '../api';
import type { SessionFilters, SessionSummary } from '../types/api';
import { getProjectId } from '../utils';
import { applySessionFilters, sessionPageRequest } from '../components/session-list-query';
import { useEnvironmentFilter } from '../composables/useEnvironmentFilter';
import SessionLedgerRow from '../components/sessions/SessionLedgerRow.vue';
import Button from '../components/ui/Button.vue';
import EmptyState from '../components/ui/EmptyState.vue';
import InlineAlert from '../components/ui/InlineAlert.vue';
import SelectField from '../components/ui/SelectField.vue';
import SkeletonBlock from '../components/ui/SkeletonBlock.vue';
import TextInput from '../components/ui/TextInput.vue';

type DatePreset = '24h' | '7d' | '30d' | 'custom';

const sessions = ref<SessionSummary[]>([]);
const projectId = ref('');
const loading = ref(true);
const hasLoaded = ref(false);
const loadingMore = ref(false);
const error = ref<string | null>(null);
const paginationError = ref<string | null>(null);
const nextCursor = ref<string | null>(null);
const hasIdentifiedSessions = ref(true);
const anonymousHintDismissed = ref(false);
const search = ref('');
const datePreset = ref<DatePreset>('24h');
const customFrom = ref('');
const customTo = ref('');
const withSignals = ref(false);
const appliedFilters = ref<SessionFilters>({});
let fetchGeneration = 0;

const {
  environments,
  filterAvailable,
  selectedEnvironmentId,
} = useEnvironmentFilter(projectId, 'sessions');

const environmentOptions = computed(() => [
  { value: '', label: 'All environments' },
  ...environments.value.map((environment) => ({ value: environment.id, label: environment.name })),
]);
const dateOptions = [
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'custom', label: 'Custom range' },
];
const filtersActive = computed(() =>
  search.value.trim().length > 0
  || datePreset.value !== '24h'
  || selectedEnvironmentId.value.length > 0
  || withSignals.value);
const showAnonymousHint = computed(() =>
  hasLoaded.value
  && sessions.value.length > 0
  && !hasIdentifiedSessions.value
  && !anonymousHintDismissed.value);
const initialLoading = computed(() => loading.value && !hasLoaded.value);

function isoDate(value: string): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function presetStart(preset: Exclude<DatePreset, 'custom'>): string {
  const days = preset === '24h' ? 1 : preset === '7d' ? 7 : 30;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1_000).toISOString();
}

function filters(): SessionFilters {
  if (datePreset.value === 'custom') {
    return {
      search: search.value.trim() || undefined,
      has_signals: withSignals.value || undefined,
      environment_id: filterAvailable.value ? selectedEnvironmentId.value || undefined : undefined,
      from: isoDate(customFrom.value),
      to: isoDate(customTo.value),
    };
  }
  return {
    search: search.value.trim() || undefined,
    has_signals: withSignals.value || undefined,
    environment_id: filterAvailable.value ? selectedEnvironmentId.value || undefined : undefined,
    from: presetStart(datePreset.value),
    to: undefined,
  };
}

async function fetchSessions(cursor?: string): Promise<void> {
  const generation = ++fetchGeneration;
  if (cursor) {
    loadingMore.value = true;
    paginationError.value = null;
  } else {
    loading.value = true;
    error.value = null;
  }

  try {
    const request = sessionPageRequest(appliedFilters.value, cursor);
    const response = await listSessions(projectId.value, request.filters, request.cursor);
    if (generation !== fetchGeneration) return;
    sessions.value = cursor ? [...sessions.value, ...response.sessions] : response.sessions;
    nextCursor.value = response.next_cursor ?? null;
    hasIdentifiedSessions.value = response.has_identified_sessions;
    hasLoaded.value = true;
  } catch (caught: unknown) {
    if (generation !== fetchGeneration) return;
    const message = caught instanceof Error ? caught.message : String(caught);
    if (cursor) paginationError.value = message;
    else {
      error.value = message;
      hasLoaded.value = true;
    }
  } finally {
    if (generation === fetchGeneration) {
      loading.value = false;
      loadingMore.value = false;
    }
  }
}

function applyFilters(): void {
  fetchGeneration++;
  const applied = applySessionFilters(filters());
  appliedFilters.value = applied.filters;
  nextCursor.value = applied.cursor;
  paginationError.value = null;
  void fetchSessions();
}

function selectEnvironment(value: string): void {
  selectedEnvironmentId.value = value;
  applyFilters();
}

function selectDatePreset(value: string): void {
  datePreset.value = value as DatePreset;
  if (datePreset.value !== 'custom') applyFilters();
}

function setSignalsFilter(enabled: boolean): void {
  withSignals.value = enabled;
  applyFilters();
}

function clearFilters(): void {
  search.value = '';
  datePreset.value = '24h';
  customFrom.value = '';
  customTo.value = '';
  selectedEnvironmentId.value = '';
  withSignals.value = false;
  applyFilters();
}

watch(filterAvailable, (ready) => {
  if (ready && selectedEnvironmentId.value) applyFilters();
});

onMounted(() => {
  projectId.value = getProjectId();
  if (!projectId.value) {
    error.value = 'No project configured.';
    loading.value = false;
    hasLoaded.value = true;
    return;
  }
  appliedFilters.value = filters();
  void fetchSessions();
});
</script>

<template>
  <div class="mx-auto w-full max-w-[1120px]">
    <header class="mb-7 border-b border-border pb-5">
      <p class="text-xs font-semibold uppercase tracking-[0.18em] text-accent">Session ledger</p>
      <div class="mt-2 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 class="text-2xl font-semibold tracking-tight text-text">Recorded sessions</h1>
          <p class="mt-1 max-w-2xl text-sm text-muted">Browse scrubbed recordings by user, account, and time.</p>
        </div>
        <p v-if="hasLoaded && (!error || sessions.length)" class="font-mono text-xs text-muted">
          {{ sessions.length }} loaded
        </p>
      </div>
    </header>

    <form class="mb-5 flex flex-wrap items-end gap-3" @submit.prevent="applyFilters">
      <TextInput
        v-model="search"
        type="search"
        label="Search"
        placeholder="Search by user, email, or session ID"
        :disabled="loading"
        class="w-full sm:min-w-72 sm:flex-1"
      />
      <SelectField
        :model-value="datePreset"
        label="Date range"
        :options="dateOptions"
        :disabled="loading"
        class="min-w-40 flex-1 sm:max-w-52"
        @update:model-value="selectDatePreset"
      />
      <SelectField
        v-if="filterAvailable"
        :model-value="selectedEnvironmentId"
        label="Environment"
        :options="environmentOptions"
        :disabled="loading"
        class="min-w-40 flex-1 sm:max-w-56"
        @update:model-value="selectEnvironment"
      />
      <fieldset class="grid gap-1.5">
        <legend class="text-sm font-medium text-text">Signals</legend>
        <div class="inline-flex min-h-10 max-md:min-h-11 rounded-md border border-border-strong bg-surface p-0.5">
          <button
            type="button"
            class="px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            :class="!withSignals ? 'bg-text text-surface' : 'text-muted hover:text-text'"
            :aria-pressed="!withSignals"
            :disabled="loading"
            @click="setSignalsFilter(false)"
          >All</button>
          <button
            type="button"
            class="px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            :class="withSignals ? 'bg-text text-surface' : 'text-muted hover:text-text'"
            :aria-pressed="withSignals"
            :disabled="loading"
            @click="setSignalsFilter(true)"
          >With signals</button>
        </div>
      </fieldset>
      <button
        v-if="filtersActive"
        type="button"
        class="min-h-10 self-end px-2 text-sm font-medium text-accent underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        :disabled="loading"
        @click="clearFilters"
      >Clear filters</button>
      <button type="submit" class="sr-only" :disabled="loading">Search sessions</button>

      <div v-if="datePreset === 'custom'" class="flex w-full flex-wrap gap-3">
        <TextInput
          v-model="customFrom"
          type="datetime-local"
          label="From"
          :disabled="loading"
          class="min-w-56 flex-1"
          @change="applyFilters"
        />
        <TextInput
          v-model="customTo"
          type="datetime-local"
          label="To"
          :disabled="loading"
          class="min-w-56 flex-1"
          @change="applyFilters"
        />
      </div>
    </form>

    <InlineAlert v-if="showAnonymousHint" title="Anonymous recordings" tone="info" class="mb-5">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <p>
          These sessions have no user attached. Call <code class="font-mono">setUser()</code> to see who they are.
          Identifying fields are sent unmasked.
          <a
            href="https://docs.opslane.com/guides/replay-privacy/"
            target="_blank"
            rel="noopener noreferrer"
            class="font-semibold underline underline-offset-2"
          >Review replay privacy</a>.
        </p>
        <button
          type="button"
          class="shrink-0 font-semibold underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          aria-label="Dismiss anonymous recordings notice"
          @click="anonymousHintDismissed = true"
        >Dismiss</button>
      </div>
    </InlineAlert>

    <div
      v-if="initialLoading"
      role="status"
      aria-busy="true"
      aria-label="Loading recorded sessions"
      class="grid gap-3 border-y border-border py-5"
    >
      <SkeletonBlock class="h-14" />
      <SkeletonBlock class="h-14" />
      <SkeletonBlock class="h-14" />
    </div>

    <template v-else>
      <InlineAlert v-if="error" tone="danger" title="Unable to load sessions" class="mb-4">
        <p v-text="error"></p>
        <Button class="mt-3" variant="secondary" :disabled="loading" @click="fetchSessions()">Retry</Button>
      </InlineAlert>

      <EmptyState
        v-if="!error && sessions.length === 0 && withSignals"
        title="No sessions with signals"
        description="No analyzed sessions in this range have accepted errors or friction signals."
      >
        <Button variant="secondary" @click="setSignalsFilter(false)">Show all sessions</Button>
      </EmptyState>

      <EmptyState
        v-else-if="!error && sessions.length === 0 && filtersActive"
        title="No sessions match these filters"
        description="Try widening the date range or clearing the search."
      >
        <Button variant="secondary" @click="clearFilters">Clear filters</Button>
      </EmptyState>

      <EmptyState
        v-else-if="!error && sessions.length === 0"
        title="No sessions recorded yet"
        description="Recordings appear after the SDK sends its first chunk."
      >
        <router-link
          to="/setup"
          class="inline-flex min-h-10 items-center bg-accent px-4 py-2 text-sm font-semibold text-on-accent hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
        >Setup guide</router-link>
      </EmptyState>

      <div
        v-if="sessions.length"
        class="overflow-x-auto border-y border-border"
        :aria-busy="loading || loadingMore || undefined"
      >
        <table class="min-w-full table-fixed text-sm" aria-label="Recorded sessions">
          <thead>
            <tr class="border-b border-border bg-surface-subtle">
              <th scope="col" class="w-[60%] px-2 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.14em] text-muted sm:w-[45%] sm:px-4">
                Session
              </th>
              <th scope="col" class="hidden w-[30%] px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.14em] text-muted sm:table-cell">
                Signals
              </th>
              <th scope="col" class="w-[40%] px-2 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.14em] text-muted sm:w-[25%] sm:px-4">
                Started
              </th>
            </tr>
          </thead>
          <tbody>
            <SessionLedgerRow
              v-for="session in sessions"
              :key="session.id"
              :session="session"
            />
          </tbody>
        </table>
      </div>

      <InlineAlert v-if="paginationError" tone="danger" title="Unable to load more sessions" class="mt-4">
        <p v-text="paginationError"></p>
        <Button
          v-if="nextCursor"
          class="mt-3"
          variant="secondary"
          :disabled="loadingMore"
          @click="fetchSessions(nextCursor)"
        >Retry</Button>
      </InlineAlert>

      <div v-if="nextCursor && !paginationError" class="mt-5 text-center">
        <Button variant="secondary" :disabled="loadingMore" @click="fetchSessions(nextCursor)">
          {{ loadingMore ? 'Loading...' : 'Load more' }}
        </Button>
      </div>
    </template>
  </div>
</template>
