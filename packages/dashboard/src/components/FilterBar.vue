<script setup lang="ts">
import { ref, onMounted, toRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { Account, IncidentFilters } from '../types/api';
import { listAccounts } from '../api';
import { environmentFilterQuery, useEnvironmentFilter } from '../composables/useEnvironmentFilter';

const props = defineProps<{
  projectId: string;
  defaultEnvironmentId?: string | null;
}>();

const emit = defineEmits<{
  (e: 'filter-change', filters: IncidentFilters): void;
}>();

const route = useRoute();
const router = useRouter();
const accounts = ref<Account[]>([]);
const selectedAccountId = ref((route.query['account_id'] as string) || '');
const selectedStatus = ref((route.query['status'] as string) || '');
const rawPlatform = route.query['platform'];
const selectedPlatform = ref<'' | 'javascript' | 'python'>(
  rawPlatform === 'javascript' || rawPlatform === 'python' ? rawPlatform : '',
);
const rawEndUserId = route.query['end_user_id'];
const selectedEndUserId = ref(typeof rawEndUserId === 'string' ? rawEndUserId : '');
const {
  clear: clearEnvironment,
  environments,
  filterAvailable,
  resetToDefault: resetEnvironmentToDefault,
  rollupReady,
  selectedEnvironmentId,
} = useEnvironmentFilter(
  toRef(props, 'projectId'),
  'incidents',
  toRef(props, 'defaultEnvironmentId'),
);

onMounted(() => {
  // Apply URL-derived filters immediately. Account options are auxiliary and
  // must not delay (or race) the activity feed's initial scoped request.
  emitFilters();
  void loadAccounts();
});

async function loadAccounts() {
  try {
    accounts.value = await listAccounts(props.projectId);
  } catch {
    // Non-fatal: filter bar still works without account list
  }
}

function emitFilters() {
  const filters: IncidentFilters = {};
  if (selectedAccountId.value) filters.account_id = selectedAccountId.value;
  if (selectedEndUserId.value) filters.end_user_id = selectedEndUserId.value;
  if (selectedStatus.value) filters.status = selectedStatus.value;
  if (selectedPlatform.value) filters.platform = selectedPlatform.value;
  if (rollupReady.value && selectedEnvironmentId.value) {
    filters.environment_id = selectedEnvironmentId.value;
  }
  emit('filter-change', filters);
}

function onFilterChange() {
  // Sync to URL query params
  const query = environmentFilterQuery(route.query, selectedEnvironmentId.value);
  if (selectedAccountId.value) {
    query['account_id'] = selectedAccountId.value;
  } else {
    delete query['account_id'];
  }
  if (selectedStatus.value) {
    query['status'] = selectedStatus.value;
  } else {
    delete query['status'];
  }
  if (selectedPlatform.value) {
    query['platform'] = selectedPlatform.value;
  } else {
    delete query['platform'];
  }
  if (selectedEndUserId.value) {
    query['end_user_id'] = selectedEndUserId.value;
  } else {
    delete query['end_user_id'];
  }
  router.replace({ query });
  emitFilters();
}

function reset() {
  selectedAccountId.value = '';
  selectedStatus.value = '';
  selectedPlatform.value = '';
  selectedEndUserId.value = '';
  resetEnvironmentToDefault();
}

function onEnvironmentChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  if (value) selectedEnvironmentId.value = value;
  else clearEnvironment();
}

function showArchived() {
  // The watcher on selectedStatus performs the URL sync and re-emit, so every
  // other active filter is preserved and only status changes.
  selectedStatus.value = 'archived';
}

defineExpose({ reset, showArchived });

watch(
  [selectedAccountId, selectedStatus, selectedPlatform, selectedEnvironmentId, rollupReady],
  onFilterChange,
);
</script>

<template>
  <div class="flex flex-wrap items-center gap-2 py-3">
    <div class="relative">
      <svg
        aria-hidden="true"
        class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
      >
        <circle cx="12" cy="8" r="3" />
        <path d="M5 20c.8-4 3.1-6 7-6s6.2 2 7 6" />
      </svg>
      <select
        v-model="selectedAccountId"
        aria-label="Account"
        class="min-h-10 max-md:min-h-11 rounded-md border border-border bg-surface py-1.5 pl-9 pr-8 text-sm"
      >
        <option value="">All accounts</option>
        <option
          v-for="account in accounts"
          :key="account.external_account_id"
          :value="account.external_account_id"
          v-text="account.account_name || account.external_account_id"
        ></option>
      </select>
    </div>

    <div class="relative">
      <svg
        aria-hidden="true"
        class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
      >
        <circle cx="12" cy="12" r="8" />
        <path d="M12 8v4l2.5 2.5" />
      </svg>
      <select
        v-model="selectedStatus"
        aria-label="Status"
        class="min-h-10 max-md:min-h-11 rounded-md border border-border bg-surface py-1.5 pl-9 pr-8 text-sm"
      >
        <option value="">All statuses</option>
        <option value="new">New</option>
        <option value="queued">Queued</option>
        <option value="analyzing">Analyzing</option>
        <option value="pr_draft">Draft PR</option>
        <option value="pr_created">PR Created</option>
        <option value="merged">Merged</option>
        <option value="needs_human">Needs Human</option>
        <option value="resolved">Resolved</option>
        <option value="archived">Archived</option>
      </select>
    </div>

    <div class="relative">
      <svg
        aria-hidden="true"
        class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
      >
        <path d="M8 4h8l4 8-4 8H8l-4-8 4-8Z" />
        <circle cx="12" cy="12" r="2" />
      </svg>
      <select
        v-model="selectedPlatform"
        aria-label="Platform"
        class="min-h-10 max-md:min-h-11 rounded-md border border-border bg-surface py-1.5 pl-9 pr-8 text-sm"
      >
        <option value="">All platforms</option>
        <option value="javascript">JavaScript</option>
        <option value="python">Python</option>
      </select>
    </div>

    <div v-if="filterAvailable" class="relative">
      <svg
        aria-hidden="true"
        class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
      >
        <path d="M5 5h14v14H5zM5 10h14M10 10v9" />
      </svg>
      <select
        :value="selectedEnvironmentId"
        aria-label="Environment"
        class="min-h-10 max-md:min-h-11 rounded-md border border-border bg-surface py-1.5 pl-9 pr-8 text-sm"
        @change="onEnvironmentChange"
      >
        <option value="">All environments</option>
        <option
          v-for="environment in environments"
          :key="environment.id"
          :value="environment.id"
          v-text="environment.name"
        ></option>
      </select>
    </div>
  </div>
</template>
