import { computed, onMounted, ref, toValue, watch, type MaybeRef } from 'vue';
import { useRoute, useRouter, type LocationQuery, type LocationQueryRaw } from 'vue-router';

import { listEnvironments, type Environment } from '../api';

export const ENVIRONMENT_STORAGE_KEY = 'opslane_environment_id';
export const ALL_ENVIRONMENTS_SENTINEL = '__all__';

type QueryValue = string | null | undefined | Array<string | null>;
type EnvironmentStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function environmentStorageKey(projectId: string): string {
  return `${ENVIRONMENT_STORAGE_KEY}:${projectId}`;
}

export function initialEnvironmentId(
  queryValue: QueryValue,
  storedValue: string | null,
  defaultEnvironmentId?: string | null,
): string {
  const value = Array.isArray(queryValue) ? queryValue[0] : queryValue;
  if (value) return value;
  if (storedValue === ALL_ENVIRONMENTS_SENTINEL) return '';
  return storedValue || defaultEnvironmentId || '';
}

export function environmentFilterQuery(
  currentQuery: Readonly<LocationQuery>,
  environmentId: string,
): LocationQueryRaw {
  const query: LocationQueryRaw = { ...currentQuery };
  if (environmentId) query['environment_id'] = environmentId;
  else delete query['environment_id'];
  return query;
}

export function persistEnvironmentId(
  storage: EnvironmentStorage,
  environmentId: string,
  projectId: string,
  explicitClear: boolean,
): void {
  const key = environmentStorageKey(projectId);
  if (environmentId) storage.setItem(key, environmentId);
  else if (explicitClear) storage.setItem(key, ALL_ENVIRONMENTS_SENTINEL);
  else storage.removeItem(key);
}

export function useEnvironmentFilter(
  projectId: MaybeRef<string>,
  usedBy: 'incidents' | 'sessions',
  defaultEnvironmentId?: MaybeRef<string | null | undefined>,
) {
  const route = useRoute();
  const router = useRouter();
  const environments = ref<Environment[]>([]);
  const rollupReady = ref(false);
  const filterAvailable = computed(() => environments.value.length >= 2
    && (usedBy === 'sessions' || rollupReady.value));
  const loading = ref(false);
  let loadGeneration = 0;
  // Value (not boolean) suppression: Vue batches same-tick ref writes into one
  // watcher invocation, so "reset to '' then apply the default" must not let a
  // suppression armed for '' swallow the sync of the default that actually won.
  let suppressSyncFor: string | null = null;
  const selectedEnvironmentId = ref(initialEnvironmentId(
    route.query['environment_id'],
    localStorage.getItem(environmentStorageKey(toValue(projectId))),
  ));

  function syncSelection(environmentId: string, explicitClear = false): void {
    persistEnvironmentId(localStorage, environmentId, toValue(projectId), explicitClear);
    void router.replace({ query: environmentFilterQuery(route.query, environmentId) });
  }

  function clear(): void {
    syncSelection('', true);
    if (selectedEnvironmentId.value !== '') {
      suppressSyncFor = '';
      selectedEnvironmentId.value = '';
    }
  }

  function resetForInvalidSelection(): void {
    syncSelection('');
    if (selectedEnvironmentId.value !== '') {
      suppressSyncFor = '';
      selectedEnvironmentId.value = '';
    }
  }

  // Reset buttons ("Clear filters") are an implicit clear: the stored choice is
  // dropped rather than replaced with the all-environments sentinel, and the
  // project default re-applies immediately when the loaded options confirm it.
  // Only choosing "All environments" in the filter itself records the sentinel
  // (clear()).
  function resetToDefault(): void {
    const fallback = toValue(defaultEnvironmentId);
    const next = filterAvailable.value && fallback
      && environments.value.some((environment) => environment.id === fallback)
      ? fallback
      : '';
    syncSelection(next);
    if (selectedEnvironmentId.value !== next) {
      suppressSyncFor = next;
      selectedEnvironmentId.value = next;
    }
  }

  async function loadOptions(): Promise<void> {
    const id = toValue(projectId);
    const generation = ++loadGeneration;
    if (!id) {
      environments.value = [];
      rollupReady.value = false;
      return;
    }
    loading.value = true;
    try {
      const response = await listEnvironments(id, usedBy);
      if (generation !== loadGeneration || id !== toValue(projectId)) return;
      environments.value = response.environments;
      rollupReady.value = response.rollup_ready;
      if (!filterAvailable.value || (selectedEnvironmentId.value &&
          !response.environments.some((environment) => environment.id === selectedEnvironmentId.value))) {
        resetForInvalidSelection();
      }
      const fallback = toValue(defaultEnvironmentId);
      if (
        filterAvailable.value
        && !selectedEnvironmentId.value
        && localStorage.getItem(environmentStorageKey(id)) !== ALL_ENVIRONMENTS_SENTINEL
        && fallback
        && response.environments.some((environment) => environment.id === fallback)
      ) {
        selectedEnvironmentId.value = fallback;
      }
    } catch {
      if (generation !== loadGeneration || id !== toValue(projectId)) return;
      environments.value = [];
      rollupReady.value = false;
      resetForInvalidSelection();
    } finally {
      if (generation === loadGeneration) loading.value = false;
    }
  }

  watch(selectedEnvironmentId, (next) => {
    const suppressed = suppressSyncFor;
    suppressSyncFor = null;
    if (suppressed !== null && next === suppressed) return;
    syncSelection(next);
  });
  watch(
    () => toValue(projectId),
    (next, previous) => {
      if (next !== previous) {
        const nextSelection = initialEnvironmentId(
          undefined,
          localStorage.getItem(environmentStorageKey(next)),
        );
        if (nextSelection !== selectedEnvironmentId.value) {
          suppressSyncFor = nextSelection;
          selectedEnvironmentId.value = nextSelection;
        }
      }
      void loadOptions();
    },
  );
  watch(
    () => toValue(defaultEnvironmentId),
    (next, previous) => {
      if (next !== previous) void loadOptions();
    },
  );
  onMounted(() => { void loadOptions(); });

  return {
    clear,
    environments,
    filterAvailable,
    loading,
    loadOptions,
    resetToDefault,
    rollupReady,
    selectedEnvironmentId,
  };
}
