<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue';
import type { Incident, IncidentFilters, ErrorGroupStatus } from '../types/api';
import { listIncidents } from '../api';
import { getProjectId } from '../utils';
import { useTableSort } from '../composables/useTableSort';
import FilterBar from '../components/FilterBar.vue';
import IssueRow from '../components/incidents/IssueRow.vue';
import InlineAlert from '../components/ui/InlineAlert.vue';
import EmptyState from '../components/ui/EmptyState.vue';
import SkeletonBlock from '../components/ui/SkeletonBlock.vue';

const POLL_INTERVAL = 30_000; // 30 seconds

const incidents = ref<Incident[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const projectId = ref('');
const currentFilters = ref<IncidentFilters>({});
const filterBar = ref<InstanceType<typeof FilterBar> | null>(null);
let fetchGeneration = 0;

const statusOrder: Record<ErrorGroupStatus, number> = {
  candidate: -1,
  new: 0,
  queued: 1,
  analyzing: 2,
  fixing: 3,
  investigated: 4,
  awaiting_approval: 4,
  pr_draft: 5,
  pr_created: 6,
  needs_human: 7,
  insight: 8,
  resolved: 8,
  merged: 9,
  archived: 10,
};

type SortKey = 'last_seen' | 'occurrences' | 'users' | 'status' | 'age';

const {
  sortKey,
  sorted: sortedIncidents,
  toggleSort,
  sortIndicator,
  ariaSort,
} = useTableSort<SortKey, Incident>(
  incidents,
  'users',
  {
    occurrences: (a, b) => a.occurrence_count - b.occurrence_count,
    users: (a, b) => a.affected_users_count - b.affected_users_count,
    status: (a, b) => (statusOrder[a.status] ?? 99) - (statusOrder[b.status] ?? 99),
    last_seen: (a, b) => new Date(a.last_seen).getTime() - new Date(b.last_seen).getTime(),
    // Natural ascending sense: newer first_seen means a smaller age. The
    // default descending direction negates this, putting the oldest issue first.
    age: (a, b) => new Date(b.first_seen).getTime() - new Date(a.first_seen).getTime(),
  },
);

const platformsVary = computed(
  () => new Set(incidents.value.map((incident) => incident.platform).filter(Boolean)).size > 1,
);
const hasActiveFilters = computed(() => Object.keys(currentFilters.value).length > 0);
const viewingArchived = computed(() => currentFilters.value.status === 'archived');

function viewArchived() {
  filterBar.value?.showArchived();
}

const newIncidentCount = ref(0);
let pollTimer: ReturnType<typeof setInterval> | null = null;

async function fetchIncidents(filters?: IncidentFilters) {
  const generation = ++fetchGeneration;
  loading.value = true;
  error.value = null;
  newIncidentCount.value = 0;
  try {
    const result = await listIncidents(projectId.value, filters);
    if (generation !== fetchGeneration) return;
    incidents.value = result;
  } catch (e: unknown) {
    if (generation !== fetchGeneration) return;
    const msg = e instanceof Error ? e.message : String(e);
    error.value = `Failed to load issues: ${msg}`;
  } finally {
    if (generation === fetchGeneration) loading.value = false;
  }
}

async function pollForNew() {
  try {
    const latest = await listIncidents(projectId.value, currentFilters.value);
    // Count unseen ids rather than a length delta. Archiving removes rows from
    // the default feed, so a shrink can cancel out an arrival: 3 archived plus
    // 2 new reads as a net -1, the banner stays hidden, and since the banner is
    // the only thing that refetches, the feed freezes on stale rows.
    const known = new Set(incidents.value.map((incident) => incident.id));
    newIncidentCount.value = latest.filter((incident) => !known.has(incident.id)).length;
  } catch {
    // Silent — polling failure is non-fatal
  }
}

function loadNewIncidents() {
  fetchIncidents(currentFilters.value);
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(pollForNew, POLL_INTERVAL);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function onFilterChange(filters: IncidentFilters) {
  currentFilters.value = filters;
  fetchIncidents(filters);
}

function clearFilters() {
  filterBar.value?.reset();
}

function onMobileSortChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value as SortKey;
  if (value !== sortKey.value) toggleSort(value);
}

onMounted(async () => {
  projectId.value = getProjectId();
  if (!projectId.value) {
    error.value = 'No project configured. Set project_id in query params or localStorage.';
    loading.value = false;
    return;
  }

  startPolling();
});

onUnmounted(() => stopPolling());
</script>

<template>
  <div class="mx-auto w-full max-w-[1120px]">
    <header class="mb-4">
      <h1 class="text-3xl font-semibold tracking-tight text-text">Issues</h1>
    </header>

    <div v-if="projectId" class="mb-3 flex flex-wrap items-center gap-2">
      <FilterBar
        ref="filterBar"
        :project-id="projectId"
        class="w-full sm:min-w-0 sm:flex-1"
        @filter-change="onFilterChange"
      />
      <label class="flex items-center gap-2 text-sm text-muted sm:hidden">
        <span>Sort:</span>
        <span class="relative">
          <svg
            aria-hidden="true"
            class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
          >
            <path d="M8 7h10M8 12h7M8 17h4M4 6v12m0 0-2-2m2 2 2-2" />
          </svg>
          <select
            aria-label="Sort issues"
            :value="sortKey"
            class="min-h-10 max-md:min-h-11 rounded-md border border-border bg-surface py-1.5 pl-9 pr-8 text-sm text-text"
            @change="onMobileSortChange"
          >
            <option value="users">Most users</option>
            <option value="occurrences">Most events</option>
            <option value="last_seen">Most recent</option>
            <option value="age">Oldest issues</option>
            <option value="status">Status</option>
          </select>
        </span>
      </label>
    </div>

    <button
      v-if="newIncidentCount > 0"
      class="mb-4 w-full border border-accent bg-surface px-4 py-2 text-center text-sm font-semibold text-accent hover:bg-surface-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      @click="loadNewIncidents"
    >
      {{ newIncidentCount }} new issue{{ newIncidentCount === 1 ? '' : 's' }} — click to refresh
    </button>

    <div
      v-if="loading"
      role="status"
      aria-busy="true"
      aria-label="Loading issues"
      class="grid gap-3 rounded-lg border border-border p-5"
    >
      <SkeletonBlock class="h-14" />
      <SkeletonBlock class="h-14" />
      <SkeletonBlock class="h-14" />
    </div>

    <InlineAlert
      v-else-if="error"
      tone="danger"
      title="Unable to load issues"
    >
      <p v-text="error"></p>
    </InlineAlert>

    <template v-else-if="incidents.length === 0">
      <EmptyState
        v-if="hasActiveFilters"
        title="No issues match these filters"
        description="Try widening or clearing them."
      >
        <button
          type="button"
          class="inline-flex min-h-10 items-center rounded-sm border border-border-strong bg-surface px-4 py-2 text-sm font-semibold text-text hover:bg-surface-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          @click="clearFilters"
        >
          Clear filters
        </button>
        <button
          v-if="!viewingArchived"
          type="button"
          data-testid="view-archived"
          class="mx-auto mt-3 block text-sm text-muted underline underline-offset-4 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          @click="viewArchived"
        >
          View archived issues
        </button>
      </EmptyState>
      <EmptyState
        v-else
        title="No issues yet"
        description="Events will appear once your SDK starts reporting errors."
      >
        <router-link
          to="/setup"
          class="inline-flex min-h-10 items-center bg-accent px-4 py-2 text-sm font-semibold text-on-accent hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
        >
          Setup guide
        </router-link>
        <button
          v-if="!viewingArchived"
          type="button"
          data-testid="view-archived"
          class="mx-auto mt-3 block text-sm text-muted underline underline-offset-4 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          @click="viewArchived"
        >
          View archived issues
        </button>
      </EmptyState>
    </template>

    <template v-else>
      <div
        class="overflow-hidden rounded-lg border border-border sm:hidden"
        data-testid="stacked-issues-list"
      >
        <IssueRow
          v-for="incident in sortedIncidents"
          :key="incident.id"
          :incident="incident"
          :project-id="projectId"
          :show-platform="platformsVary"
          layout="stacked"
        />
      </div>

      <div class="hidden overflow-x-auto rounded-lg border border-border sm:block">
        <table class="min-w-full text-sm" aria-label="Issues">
        <thead>
          <tr class="border-b border-border bg-surface-subtle">
            <th scope="col" class="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.14em] text-muted sm:px-5">
              Title
            </th>
            <th
              scope="col"
              :aria-sort="ariaSort('status')"
              class="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.14em] text-muted"
            >
              <button type="button" class="inline-flex items-center gap-1 uppercase tracking-[0.14em] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" @click="toggleSort('status')">
                Status<span aria-hidden="true">{{ sortIndicator('status') }}</span>
              </button>
            </th>
            <th
              scope="col"
              :aria-sort="ariaSort('occurrences')"
              class="hidden px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-[0.14em] text-muted sm:table-cell"
            >
              <button type="button" class="inline-flex items-center gap-1 uppercase tracking-[0.14em] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" @click="toggleSort('occurrences')">
                Events<span aria-hidden="true">{{ sortIndicator('occurrences') }}</span>
              </button>
            </th>
            <th
              scope="col"
              :aria-sort="ariaSort('users')"
              :title="currentFilters.environment_id ? 'users across all environments' : undefined"
              class="hidden px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-[0.14em] text-muted lg:table-cell"
            >
              <button type="button" class="inline-flex items-center gap-1 uppercase tracking-[0.14em] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" @click="toggleSort('users')">
                Users<span aria-hidden="true">{{ sortIndicator('users') }}</span>
              </button>
              <span v-if="currentFilters.environment_id" class="block text-[10px] normal-case tracking-normal">
                across all environments
              </span>
            </th>
            <th
              scope="col"
              :aria-sort="ariaSort('age')"
              title="Time since this issue was first seen"
              class="hidden px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-[0.14em] text-muted lg:table-cell"
            >
              <button type="button" class="inline-flex items-center gap-1 uppercase tracking-[0.14em] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" @click="toggleSort('age')">
                Age<span aria-hidden="true">{{ sortIndicator('age') }}</span>
              </button>
            </th>
            <th
              scope="col"
              :aria-sort="ariaSort('last_seen')"
              class="hidden px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-[0.14em] text-muted xl:table-cell"
            >
              <button type="button" class="inline-flex items-center gap-1 uppercase tracking-[0.14em] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" @click="toggleSort('last_seen')">
                Last Seen<span aria-hidden="true">{{ sortIndicator('last_seen') }}</span>
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          <IssueRow
            v-for="incident in sortedIncidents"
            :key="incident.id"
            :incident="incident"
            :project-id="projectId"
            :show-platform="platformsVary"
          />
        </tbody>
        </table>
      </div>
    </template>

    <p v-if="!loading && !error && incidents.length > 0" class="mt-3 text-xs text-muted">
      {{ incidents.length }} issue{{ incidents.length === 1 ? '' : 's' }}
    </p>
  </div>
</template>
