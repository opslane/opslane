// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, nextTick, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';

import { listEnvironments } from '../api';
import {
  ALL_ENVIRONMENTS_SENTINEL,
  environmentStorageKey,
  environmentFilterQuery,
  initialEnvironmentId,
  persistEnvironmentId,
  useEnvironmentFilter,
} from './useEnvironmentFilter';

vi.mock('../api', () => ({ listEnvironments: vi.fn() }));

const environment = (id: string, name: string) => ({
  id,
  project_id: 'p1',
  name,
  created_at: '2026-01-01T00:00:00Z',
});

/**
 * Mounts the composable behind a projectId that starts empty and is only
 * assigned after mount, which is how SessionsList.vue drives it.
 */
async function mountFilter(
  usedBy: 'incidents' | 'sessions',
  projectId = ref(''),
  defaultEnvironmentId = ref<string | null>(null),
) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }],
  });
  await router.push('/');
  await router.isReady();

  let state!: ReturnType<typeof useEnvironmentFilter>;
  const host = defineComponent({
    setup() {
      state = useEnvironmentFilter(projectId, usedBy, defaultEnvironmentId);
      return () => null;
    },
  });
  mount(host, { global: { plugins: [router] } });
  await flushPromises();
  return { projectId, state, router };
}

describe('environment filter loading', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(listEnvironments).mockReset();
  });

  it('keeps a persisted selection when projectId is only assigned after mount', async () => {
    localStorage.setItem(environmentStorageKey('p1'), 'env-staging');
    vi.mocked(listEnvironments).mockResolvedValue({
      environments: [environment('env-production', 'production'), environment('env-staging', 'staging')],
      rollup_ready: true,
    });

    const { projectId, state } = await mountFilter('sessions');
    expect(state.selectedEnvironmentId.value).toBe('');

    projectId.value = 'p1';
    await nextTick();
    await flushPromises();

    expect(listEnvironments).toHaveBeenCalledWith('p1', 'sessions');
    expect(state.selectedEnvironmentId.value).toBe('env-staging');
    expect(localStorage.getItem(environmentStorageKey('p1'))).toBe('env-staging');
  });

  it('hides the incidents filter until two observed environments and a ready rollup', async () => {
    vi.mocked(listEnvironments).mockResolvedValue({
      environments: [environment('env-production', 'production')],
      rollup_ready: true,
    });

    const { state } = await mountFilter('incidents', ref('p1'));
    expect(state.rollupReady.value).toBe(true);
    expect(state.filterAvailable.value).toBe(false);

    vi.mocked(listEnvironments).mockResolvedValue({
      environments: [environment('env-production', 'production'), environment('env-staging', 'staging')],
      rollup_ready: true,
    });
    await state.loadOptions();
    expect(state.filterAvailable.value).toBe(true);
  });

  it('ignores rollup readiness on the sessions surface', async () => {
    vi.mocked(listEnvironments).mockResolvedValue({
      environments: [environment('env-production', 'production'), environment('env-staging', 'staging')],
      rollup_ready: false,
    });

    const { state } = await mountFilter('sessions', ref('p1'));
    expect(state.filterAvailable.value).toBe(true);
  });

  it('clears state, URL, and storage when the filter is no longer available', async () => {
    localStorage.setItem(environmentStorageKey('p1'), 'env-staging');
    vi.mocked(listEnvironments).mockResolvedValue({
      environments: [environment('env-production', 'production')],
      rollup_ready: true,
    });

    const { state, router } = await mountFilter('sessions', ref('p1'));

    expect(state.selectedEnvironmentId.value).toBe('');
    expect(localStorage.getItem(environmentStorageKey('p1'))).toBeNull();
    expect(router.currentRoute.value.query['environment_id']).toBeUndefined();
  });

  it('clears a selection the response no longer contains', async () => {
    localStorage.setItem(environmentStorageKey('p1'), 'env-deleted');
    vi.mocked(listEnvironments).mockResolvedValue({
      environments: [environment('env-production', 'production'), environment('env-staging', 'staging')],
      rollup_ready: true,
    });

    const { state } = await mountFilter('sessions', ref('p1'));

    expect(state.selectedEnvironmentId.value).toBe('');
    expect(localStorage.getItem(environmentStorageKey('p1'))).toBeNull();
  });

  it('applies a valid project default after options load', async () => {
    vi.mocked(listEnvironments).mockResolvedValue({
      environments: [environment('env-production', 'production'), environment('env-staging', 'staging')],
      rollup_ready: true,
    });

    const { state } = await mountFilter('sessions', ref('p1'), ref('env-production'));

    expect(state.selectedEnvironmentId.value).toBe('env-production');
    expect(localStorage.getItem(environmentStorageKey('p1'))).toBe('env-production');
  });

  it('applies a project default that arrives after the environment options', async () => {
    const defaultEnvironmentId = ref<string | null>(null);
    vi.mocked(listEnvironments).mockResolvedValue({
      environments: [environment('env-production', 'production'), environment('env-staging', 'staging')],
      rollup_ready: true,
    });
    const { state } = await mountFilter('sessions', ref('p1'), defaultEnvironmentId);
    expect(state.selectedEnvironmentId.value).toBe('');

    defaultEnvironmentId.value = 'env-production';
    await nextTick();
    await flushPromises();

    expect(state.selectedEnvironmentId.value).toBe('env-production');
  });

  it('keeps an explicit all-environments choice across reloads', async () => {
    localStorage.setItem(environmentStorageKey('p1'), ALL_ENVIRONMENTS_SENTINEL);
    vi.mocked(listEnvironments).mockResolvedValue({
      environments: [environment('env-production', 'production'), environment('env-staging', 'staging')],
      rollup_ready: true,
    });

    const { state } = await mountFilter('sessions', ref('p1'), ref('env-production'));

    expect(state.selectedEnvironmentId.value).toBe('');
  });

  it('resetToDefault re-applies the project default and drops the sentinel', async () => {
    localStorage.setItem(environmentStorageKey('p1'), ALL_ENVIRONMENTS_SENTINEL);
    vi.mocked(listEnvironments).mockResolvedValue({
      environments: [environment('env-production', 'production'), environment('env-staging', 'staging')],
      rollup_ready: true,
    });
    const { state } = await mountFilter('sessions', ref('p1'), ref('env-production'));
    expect(state.selectedEnvironmentId.value).toBe('');

    state.resetToDefault();
    await nextTick();
    await flushPromises();

    expect(state.selectedEnvironmentId.value).toBe('env-production');
    expect(localStorage.getItem(environmentStorageKey('p1'))).toBe('env-production');
  });

  it('choosing All environments records the sentinel via clear()', async () => {
    vi.mocked(listEnvironments).mockResolvedValue({
      environments: [environment('env-production', 'production'), environment('env-staging', 'staging')],
      rollup_ready: true,
    });
    const { state } = await mountFilter('sessions', ref('p1'), ref('env-production'));
    expect(state.selectedEnvironmentId.value).toBe('env-production');

    state.clear();
    await nextTick();

    expect(state.selectedEnvironmentId.value).toBe('');
    expect(localStorage.getItem(environmentStorageKey('p1'))).toBe(ALL_ENVIRONMENTS_SENTINEL);
  });

  it('restores the incoming project persisted selection on project switch', async () => {
    localStorage.setItem(environmentStorageKey('p1'), 'env-staging');
    localStorage.setItem(environmentStorageKey('p2'), 'env-production');
    vi.mocked(listEnvironments).mockResolvedValue({
      environments: [environment('env-production', 'production'), environment('env-staging', 'staging')],
      rollup_ready: true,
    });
    const projectId = ref('p1');
    const { state } = await mountFilter('sessions', projectId);
    expect(state.selectedEnvironmentId.value).toBe('env-staging');

    projectId.value = 'p2';
    await nextTick();
    await flushPromises();

    expect(state.selectedEnvironmentId.value).toBe('env-production');
    expect(localStorage.getItem(environmentStorageKey('p1'))).toBe('env-staging');
    expect(localStorage.getItem(environmentStorageKey('p2'))).toBe('env-production');
  });
});

describe('environment filter state', () => {
  it('prefers a URL query value over the persisted selection', () => {
    expect(initialEnvironmentId('env-url', 'env-stored')).toBe('env-url');
    expect(initialEnvironmentId(undefined, 'env-stored')).toBe('env-stored');
    expect(initialEnvironmentId(['env-first', 'env-second'], 'env-stored')).toBe('env-first');
  });

  it('falls back to the project default unless all environments was explicitly chosen', () => {
    expect(initialEnvironmentId('env-url', 'env-stored', 'env-default')).toBe('env-url');
    expect(initialEnvironmentId(undefined, 'env-stored', 'env-default')).toBe('env-stored');
    expect(initialEnvironmentId(undefined, null, 'env-default')).toBe('env-default');
    expect(initialEnvironmentId(undefined, ALL_ENVIRONMENTS_SENTINEL, 'env-default')).toBe('');
    expect(initialEnvironmentId(undefined, null, null)).toBe('');
  });

  it('scopes storage keys per project', () => {
    expect(environmentStorageKey('p1')).toBe('opslane_environment_id:p1');
    expect(environmentStorageKey('p2')).not.toBe(environmentStorageKey('p1'));
  });

  it('adds and removes only environment_id in a query snapshot', () => {
    expect(environmentFilterQuery({ account_id: 'account-1' }, 'env-1')).toEqual({
      account_id: 'account-1',
      environment_id: 'env-1',
    });
    expect(environmentFilterQuery({ account_id: 'account-1', environment_id: 'env-1' }, '')).toEqual({
      account_id: 'account-1',
    });
  });

  it('persists a selection and removes it when cleared', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };

    persistEnvironmentId(storage, 'env-1', 'p1', false);
    expect(values.get(environmentStorageKey('p1'))).toBe('env-1');
    persistEnvironmentId(storage, '', 'p1', true);
    expect(values.get(environmentStorageKey('p1'))).toBe(ALL_ENVIRONMENTS_SENTINEL);
    persistEnvironmentId(storage, '', 'p1', false);
    expect(values.has(environmentStorageKey('p1'))).toBe(false);
  });
});
