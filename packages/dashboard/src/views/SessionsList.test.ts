// @vitest-environment jsdom

import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import SessionsList from './SessionsList.vue';
import { listEnvironments, listSessions } from '../api';
import type { SessionListResponse, SessionStatus, SessionSummary } from '../types/api';

vi.mock('../api', () => ({
  listEnvironments: vi.fn(),
  listSessions: vi.fn(),
}));

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'session-full-identifier-123456789',
    started_at: '2026-07-22T20:00:00Z',
    last_chunk_at: '2026-07-22T20:07:21Z',
    status: 'analyzed',
    chunk_count: 2,
    playable_chunk_count: 2,
    bytes_stored: 2_048,
    page_url: 'https://example.test/checkout?step=payment',
    end_user: {
      id: 'end-user-1',
      external_user_id: 'user-123',
      email: 'jane@acme.com',
      external_account_id: 'account-1',
      account_name: 'Acme Corp',
    },
    error_count: 3,
    rage_click_count: 2,
    dead_click_count: 1,
    form_abandon_count: 1,
    coverage: 'complete',
    activity_class: 'active',
    failed_request_count: 0,
    successful_write_count: 0,
    unverified_signal_count: 0,
    sdk_release: '1.4.2',
    ...overrides,
  };
}

function response(
  sessions: SessionSummary[],
  overrides: Partial<SessionListResponse> = {},
): SessionListResponse {
  return {
    sessions,
    next_cursor: null,
    has_identified_sessions: true,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function mountView(settle = true): Promise<VueWrapper> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/sessions', name: 'sessions', component: SessionsList },
      { path: '/sessions/:sessionId', name: 'session-detail', component: { template: '<div />' } },
      { path: '/setup', component: { template: '<div />' } },
    ],
  });
  await router.push('/sessions');
  await router.isReady();
  const wrapper = mount(SessionsList, { global: { plugins: [router] } });
  if (settle) await flushPromises();
  return wrapper;
}

function visibilityClasses(element: { classes(): string[] }): string[] {
  return element.classes().filter((value) => value === 'hidden' || /^(sm|md|lg|xl):table-cell$/.test(value));
}

describe('SessionsList ledger', () => {
  beforeEach(() => {
    vi.mocked(listSessions).mockReset();
    vi.mocked(listEnvironments).mockReset();
    localStorage.clear();
    localStorage.setItem('opslane_project_id', 'project-1');
    vi.mocked(listEnvironments).mockResolvedValue({
      environments: [
        { id: 'env-production', project_id: 'project-1', name: 'production', created_at: '' },
        { id: 'env-staging', project_id: 'project-1', name: 'staging', created_at: '' },
      ],
      rollup_ready: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    localStorage.clear();
  });

  it('renders identity, accepted signal counts, metadata, and the responsive three-column matrix', async () => {
    vi.mocked(listSessions).mockResolvedValue(response([session()]));
    const wrapper = await mountView();

    expect(wrapper.get('h1').text()).toBe('Recorded sessions');
    expect(wrapper.text()).toContain('1 loaded');
    expect(wrapper.text()).toContain('jane@acme.com');
    expect(wrapper.text()).toContain('Acme Corp');
    expect(wrapper.text()).toContain('v1.4.2');
    expect(wrapper.text()).toContain('/checkout?step=payment');
    expect(wrapper.text()).toContain('3 errors');
    expect(wrapper.text()).toContain('2 rage clicks');
    expect(wrapper.text()).toContain('1 dead click');
    expect(wrapper.text()).toContain('1 form abandon');
    expect(wrapper.get('table').attributes('aria-label')).toBe('Recorded sessions');
    expect(wrapper.get('time').attributes('datetime')).toBe('2026-07-22T20:00:00Z');

    const headers = wrapper.findAll('th');
    const cells = wrapper.findAll('tbody tr')[0]!.findAll('td');
    expect(headers.map(visibilityClasses)).toEqual([[], ['hidden', 'sm:table-cell'], []]);
    expect(cells.map(visibilityClasses)).toEqual([[], ['hidden', 'sm:table-cell'], []]);
    expect(headers.map((header) => header.attributes('scope'))).toEqual(['col', 'col', 'col']);

    const row = wrapper.get('tbody tr');
    expect(row.findAll('a')).toHaveLength(1);
    expect(row.get('a').attributes('aria-label')).toContain('Play session for jane@acme.com');
    expect(row.find('a button').exists()).toBe(false);
    expect(row.get('button[aria-label="Copy session ID"]').attributes('type')).toBe('button');
  });

  // Regression: ISSUE-001 — the anonymous short id sliced the TAIL of the
  // session id, so structured ids rendered a meaningless fragment:
  // `sess_sdk_normal_1784676521012577000` showed `12577000` (a nanosecond
  // fragment, near-identical between sessions started in the same millisecond)
  // and `session-unavailable` showed `vailable`.
  // Found by /qa on 2026-07-23
  // Report: .gstack/qa-reports/qa-report-sessions-2026-07-23.md
  it('shows the distinguishing head of an anonymous session id, not the tail', async () => {
    vi.mocked(listSessions).mockResolvedValue(response([
      session({ id: 'sess_sdk_normal_1784676521012577000', end_user: null }),
      session({ id: 'ec7a5e89-a2c5-4e7c-a282-00298b7efaed', end_user: null }),
      session({ id: 'sess_a1b2c3d4e5f60718293a4b5c6d7e8f90', end_user: null }),
    ]));
    const wrapper = await mountView();

    expect(wrapper.text()).toContain('sdk_norm');
    expect(wrapper.text()).not.toContain('12577000');

    // A UUID keeps its recognisable first block rather than its last.
    expect(wrapper.text()).toContain('ec7a5e89');
    expect(wrapper.text()).not.toContain('8b7efaed');

    // The shared `sess_` prefix is stripped so the 8 shown characters carry signal.
    expect(wrapper.text()).toContain('a1b2c3d4');

    // The full id stays available to assistive tech and to the copy control.
    const rows = wrapper.findAll('tbody tr');
    expect(rows[0]!.html()).toContain('sess_sdk_normal_1784676521012577000');
  });

  it('copies the full session id from the sibling copy control', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    vi.mocked(listSessions).mockResolvedValue(response([session()]));
    const wrapper = await mountView();

    await wrapper.get('button[aria-label="Copy session ID"]').trigger('click');
    await flushPromises();

    expect(writeText).toHaveBeenCalledWith('session-full-identifier-123456789');
  });

  it.each<[SessionStatus, number, string]>([
    ['recording', 1, 'Processing'],
    ['closed', 1, 'Processing'],
    ['analyzing', 1, 'Processing'],
    ['analysis_failed', 1, 'Unavailable'],
    ['analyzed', 0, 'No recording'],
  ])('does not link an unplayable %s session and explains %s', async (status, chunkCount, label) => {
    vi.mocked(listSessions).mockResolvedValue(response([session({
      status,
      chunk_count: chunkCount,
      playable_chunk_count: 0,
      error_count: 0,
      rage_click_count: 0,
      dead_click_count: 0,
      form_abandon_count: 0,
    })]));
    const wrapper = await mountView();

    expect(wrapper.find('tbody a').exists()).toBe(false);
    expect(wrapper.get('[aria-disabled="true"]').attributes('title')).toBe(label);
  });

  it('sends search, date, environment, and has-signals filters and clears them', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T20:00:00Z'));
    vi.mocked(listSessions).mockResolvedValue(response([session()]));
    const wrapper = await mountView();

    await wrapper.get('input[type="search"]').setValue('Acme');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(vi.mocked(listSessions)).toHaveBeenLastCalledWith(
      'project-1',
      expect.objectContaining({
        search: 'Acme',
        from: '2026-07-21T20:00:00.000Z',
      }),
      undefined,
    );

    await wrapper.findAll('select')[0].setValue('7d');
    await wrapper.findAll('select')[1].setValue('env-staging');
    await wrapper.findAll('button').find((button) => button.text() === 'With signals')!.trigger('click');
    await flushPromises();
    expect(vi.mocked(listSessions)).toHaveBeenLastCalledWith(
      'project-1',
      expect.objectContaining({
        search: 'Acme',
        from: '2026-07-15T20:00:00.000Z',
        environment_id: 'env-staging',
        has_signals: true,
      }),
      undefined,
    );

    await wrapper.findAll('button').find((button) => button.text() === 'Clear filters')!.trigger('click');
    await flushPromises();
    expect(vi.mocked(listSessions)).toHaveBeenLastCalledWith(
      'project-1',
      expect.not.objectContaining({
        search: expect.anything(),
        environment_id: expect.anything(),
        has_signals: expect.anything(),
      }),
      undefined,
    );
  });

  it('keeps existing rows when a filtered request or pagination request fails', async () => {
    vi.mocked(listSessions)
      .mockResolvedValueOnce(response([session()], { next_cursor: 'cursor-1' }))
      .mockRejectedValueOnce(new Error('filter unavailable'));
    const wrapper = await mountView();

    await wrapper.get('input[type="search"]').setValue('missing');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.text()).toContain('jane@acme.com');
    expect(wrapper.text()).toContain('Unable to load sessions');

    vi.mocked(listSessions).mockResolvedValueOnce(response([session()], { next_cursor: 'cursor-1' }));
    await wrapper.findAll('button').find((button) => button.text() === 'Retry')!.trigger('click');
    await flushPromises();
    vi.mocked(listSessions).mockRejectedValueOnce(new Error('page unavailable'));
    await wrapper.findAll('button').find((button) => button.text() === 'Load more')!.trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('jane@acme.com');
    expect(wrapper.text()).toContain('Unable to load more sessions');
  });

  it('shows loading, retry, and the distinct empty states', async () => {
    const initial = deferred<SessionListResponse>();
    vi.mocked(listSessions).mockReturnValueOnce(initial.promise);
    const wrapper = await mountView(false);
    expect(wrapper.get('[role="status"]').attributes('aria-busy')).toBe('true');
    expect(wrapper.findAllComponents({ name: 'SkeletonBlock' })).toHaveLength(3);
    initial.reject(new Error('network down'));
    await flushPromises();

    expect(wrapper.text()).toContain('Unable to load sessions');
    expect(wrapper.text()).toContain('Retry');

    vi.mocked(listSessions).mockResolvedValueOnce(response([]));
    await wrapper.findAll('button').find((button) => button.text() === 'Retry')!.trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('No sessions recorded yet');
    expect(wrapper.text()).toContain('Setup guide');
    expect(wrapper.text()).not.toContain('These sessions have no user attached');

    vi.mocked(listSessions).mockResolvedValueOnce(response([]));
    await wrapper.findAll('button').find((button) => button.text() === 'With signals')!.trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('No sessions with signals');
    expect(wrapper.text()).toContain('Show all sessions');

    vi.mocked(listSessions).mockResolvedValueOnce(response([]));
    await wrapper.findAll('button').find((button) => button.text() === 'Show all sessions')!.trigger('click');
    vi.mocked(listSessions).mockResolvedValueOnce(response([]));
    await wrapper.get('input[type="search"]').setValue('nobody@example.com');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.text()).toContain('No sessions match these filters');
  });

  it('gates the privacy-aware anonymous hint on project identity coverage and allows dismissal', async () => {
    vi.mocked(listSessions).mockResolvedValue(response([
      session({
        end_user: null,
        error_count: 0,
        rage_click_count: 0,
        dead_click_count: 0,
        form_abandon_count: 0,
      }),
    ], { has_identified_sessions: false }));
    const wrapper = await mountView();

    expect(wrapper.text()).toContain('These sessions have no user attached');
    expect(wrapper.text()).toContain('Identifying fields are sent unmasked');
    expect(wrapper.get('a[href="https://docs.opslane.com/guides/replay-privacy/"]').attributes('rel'))
      .toBe('noopener noreferrer');
    expect(wrapper.text()).toContain('Anonymous');
    // Head of the id, not the tail — see the ISSUE-001 regression test above.
    expect(wrapper.text()).toContain('session-');

    await wrapper.get('button[aria-label="Dismiss anonymous recordings notice"]').trigger('click');
    expect(wrapper.text()).not.toContain('These sessions have no user attached');
  });
});
