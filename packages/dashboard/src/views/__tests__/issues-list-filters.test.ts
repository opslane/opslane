// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Incident } from '../../types/api';

const mocks = vi.hoisted(() => ({
  listAccounts: vi.fn(),
  listEnvironments: vi.fn(),
  listIncidents: vi.fn(),
  replace: vi.fn(),
  route: { query: {} as Record<string, string> },
}));

vi.mock('../../api', () => ({
  listAccounts: mocks.listAccounts,
  listEnvironments: mocks.listEnvironments,
  listIncidents: mocks.listIncidents,
}));

vi.mock('vue-router', () => ({
  useRoute: () => mocks.route,
  useRouter: () => ({ replace: mocks.replace }),
}));

import IssuesList from '../IssuesList.vue';

function incident(
  id: string,
  title: string,
  platform: string | null,
  kind: 'error' | 'friction' = 'error',
): Incident {
  return {
    id,
    project_id: 'p1',
    kind,
    platform,
    fingerprint: `fingerprint-${id}`,
    title,
    status: kind === 'friction' ? 'insight' : 'new',
    first_seen: '2026-07-19T00:00:00Z',
    last_seen: '2026-07-19T00:00:00Z',
    occurrence_count: 1,
    affected_users_count: 1,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function mountFeed() {
  return mount(IssuesList, {
    global: {
      stubs: {
        RouterLink: { template: '<a><slot /></a>' },
      },
    },
  });
}

describe('IssuesList URL filters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listAccounts.mockResolvedValue([]);
    mocks.listEnvironments.mockResolvedValue({ environments: [], rollup_ready: false });
    mocks.route.query = {};
    window.history.replaceState({}, '', '/');
  });

  it('uses URL-derived platform and end-user filters for the only initial request', async () => {
    mocks.route.query = {
      project_id: 'p1',
      platform: 'python',
      end_user_id: 'user-123',
    };
    window.history.replaceState(
      {},
      '',
      '/?project_id=p1&platform=python&end_user_id=user-123',
    );
    mocks.listIncidents.mockResolvedValue([
      incident('python', 'Python failure', 'python'),
    ]);

    const wrapper = mountFeed();
    await flushPromises();

    expect(mocks.listIncidents).toHaveBeenCalledTimes(1);
    expect(mocks.listIncidents).toHaveBeenCalledWith('p1', {
      platform: 'python',
      end_user_id: 'user-123',
    });
    expect(wrapper.text()).toContain('Python failure');
    expect(wrapper.find('[data-testid="platform-marker"]').exists()).toBe(false);

    wrapper.unmount();
  });

  it('ignores a stale response after the platform filter changes', async () => {
    mocks.route.query = {
      project_id: 'p1',
      platform: 'python',
      end_user_id: 'user-123',
    };
    window.history.replaceState(
      {},
      '',
      '/?project_id=p1&platform=python&end_user_id=user-123',
    );
    const firstRequest = deferred<Incident[]>();
    mocks.listIncidents
      .mockImplementationOnce(() => firstRequest.promise)
      .mockResolvedValueOnce([incident('javascript', 'JavaScript failure', 'javascript')]);

    const wrapper = mountFeed();
    await flushPromises();
    // By label, not index: FilterBar has four selects and the environment one
    // is conditional, so positional lookup silently drifts.
    await wrapper.get('select[aria-label="Platform"]').setValue('javascript');
    await flushPromises();

    expect(wrapper.text()).toContain('JavaScript failure');
    expect(mocks.replace).toHaveBeenCalledWith({
      query: {
        project_id: 'p1',
        platform: 'javascript',
        end_user_id: 'user-123',
      },
    });

    firstRequest.resolve([incident('python', 'Stale Python failure', 'python')]);
    await flushPromises();

    expect(wrapper.text()).toContain('JavaScript failure');
    expect(wrapper.text()).not.toContain('Stale Python failure');

    wrapper.unmount();
  });

  it('shows friction only in the unfiltered feed and omits a platform badge for it', async () => {
    mocks.route.query = { project_id: 'p1' };
    window.history.replaceState({}, '', '/?project_id=p1');
    mocks.listIncidents.mockResolvedValue([
      incident('friction', 'Checkout friction', null, 'friction'),
      incident('python', 'Python failure', 'python'),
    ]);

    const wrapper = mountFeed();
    await flushPromises();

    expect(mocks.listIncidents).toHaveBeenCalledWith('p1', {});
    const rows = wrapper.findAll('tbody tr');
    const frictionRow = rows.find((row) => row.text().includes('Checkout friction'));
    const pythonRow = rows.find((row) => row.text().includes('Python failure'));
    expect(frictionRow?.text()).toContain('Friction');
    expect(frictionRow?.text()).not.toContain('Python');
    expect(frictionRow?.text()).not.toContain('JavaScript');
    expect(pythonRow?.find('[data-testid="platform-marker"]').exists()).toBe(false);

    wrapper.unmount();
  });

  it('shows platform markers only when the loaded list contains multiple platforms', async () => {
    mocks.route.query = { project_id: 'p1' };
    window.history.replaceState({}, '', '/?project_id=p1');
    mocks.listIncidents.mockResolvedValue([
      incident('javascript', 'JavaScript failure', 'javascript'),
      incident('python', 'Python failure', 'python'),
    ]);

    const wrapper = mountFeed();
    await flushPromises();

    const desktopRows = wrapper.findAll('tbody tr');
    expect(desktopRows[0]?.get('[data-testid="platform-marker"]').text()).toBe('JavaScript');
    expect(desktopRows[1]?.get('[data-testid="platform-marker"]').text()).toBe('Python');

    wrapper.unmount();
  });

  it('defaults to users affected descending', async () => {
    mocks.route.query = { project_id: 'p1' };
    window.history.replaceState({}, '', '/?project_id=p1');
    const lowImpact = incident('low', 'Low impact', 'javascript');
    lowImpact.affected_users_count = 2;
    const highImpact = incident('high', 'High impact', 'javascript');
    highImpact.affected_users_count = 3_000;
    mocks.listIncidents.mockResolvedValue([lowImpact, highImpact]);

    const wrapper = mountFeed();
    await flushPromises();

    expect(wrapper.findAll('tbody tr')[0]?.text()).toContain('High impact');
    const usersHeader = wrapper.findAll('thead th').find((th) => th.text().includes('Users'));
    expect(usersHeader?.attributes('aria-sort')).toBe('descending');

    wrapper.unmount();
  });

  it('renders matching desktop header and row columns with no Kind column', async () => {
    mocks.route.query = { project_id: 'p1' };
    window.history.replaceState({}, '', '/?project_id=p1');
    mocks.listIncidents.mockResolvedValue([incident('a', 'Boom', 'javascript')]);

    const wrapper = mountFeed();
    await flushPromises();

    const headers = wrapper.findAll('thead th').map((th) => th.text().replace(/[↑↓]/g, '').trim());
    expect(headers).toEqual(['Title', 'Status', 'Events', 'Users', 'Age', 'Last Seen']);
    expect(wrapper.findAll('tbody tr')[0]?.findAll('td')).toHaveLength(headers.length);

    const visibility = (el: { classes: () => string[] }) =>
      el.classes().filter((value) =>
        value === 'hidden' || /^(sm|md|lg|xl):table-cell$/.test(value)).sort();
    expect(wrapper.findAll('thead th').map(visibility))
      .toEqual(wrapper.findAll('tbody tr')[0]!.findAll('td').map(visibility));

    wrapper.unmount();
  });

  it('sorts by age from a keyboard-reachable header button', async () => {
    mocks.route.query = { project_id: 'p1' };
    window.history.replaceState({}, '', '/?project_id=p1');
    const older = incident('old', 'Older issue', 'javascript');
    older.first_seen = '2026-01-01T00:00:00Z';
    const newer = incident('new', 'Newer issue', 'javascript');
    newer.first_seen = '2026-07-01T00:00:00Z';
    mocks.listIncidents.mockResolvedValue([newer, older]);

    const wrapper = mountFeed();
    await flushPromises();

    const ageHeader = wrapper.findAll('thead th').find((th) => th.text().includes('Age'))!;
    expect(ageHeader.attributes('aria-sort')).toBe('none');
    await ageHeader.get('button').trigger('click');

    expect(wrapper.findAll('tbody tr')[0]?.text()).toContain('Older issue');
    expect(ageHeader.attributes('aria-sort')).toBe('descending');

    wrapper.unmount();
  });

  it('exposes every sortable desktop column as a button with aria-sort', async () => {
    mocks.route.query = { project_id: 'p1' };
    window.history.replaceState({}, '', '/?project_id=p1');
    mocks.listIncidents.mockResolvedValue([incident('a', 'Boom', 'javascript')]);

    const wrapper = mountFeed();
    await flushPromises();

    const headers = wrapper.findAll('thead th');
    const sortable = headers.filter((th) => th.find('button').exists());
    expect(sortable).toHaveLength(5);
    for (const header of sortable) {
      expect(header.attributes('aria-sort')).toBeDefined();
      expect(header.get('button').attributes('type')).toBe('button');
    }
    expect(headers.filter((th) => th.attributes('aria-sort') === 'descending')).toHaveLength(1);

    wrapper.unmount();
  });

  // Regression: ISSUE-001 — sortable headers rendered sentence-case while TITLE
  // stayed uppercase. base.css sets `font: inherit` on buttons, but the font
  // shorthand does not carry text-transform or letter-spacing, so wrapping each
  // label in a <button> for keyboard access silently handed those two back to
  // the UA stylesheet. jsdom does not compute inherited text-transform either,
  // so this asserts the classes rather than the computed style.
  // Found by /qa on 2026-07-23
  // Report: .gstack/qa-reports/qa-report-127-0-0-1-8099-2026-07-23.md
  it('keeps sortable header buttons on the same type treatment as Title', async () => {
    mocks.route.query = { project_id: 'p1' };
    window.history.replaceState({}, '', '/?project_id=p1');
    mocks.listIncidents.mockResolvedValue([incident('a', 'Boom', 'javascript')]);

    const wrapper = mountFeed();
    await flushPromises();

    const headers = wrapper.findAll('thead th');
    const titleHeader = headers[0]!;
    expect(titleHeader.classes()).toEqual(expect.arrayContaining(['uppercase', 'tracking-[0.14em]']));

    const buttons = headers.filter((th) => th.find('button').exists()).map((th) => th.get('button'));
    expect(buttons).toHaveLength(5);
    for (const button of buttons) {
      expect(button.classes()).toEqual(expect.arrayContaining(['uppercase', 'tracking-[0.14em]']));
    }

    wrapper.unmount();
  });

  it('renders a single-line Issues header and accessible compact filters', async () => {
    mocks.route.query = { project_id: 'p1' };
    window.history.replaceState({}, '', '/?project_id=p1');
    mocks.listIncidents.mockResolvedValue([incident('a', 'Boom', 'javascript')]);

    const wrapper = mountFeed();
    await flushPromises();

    expect(wrapper.get('h1').text()).toBe('Issues');
    expect(wrapper.get('header').text()).toBe('Issues');
    expect(wrapper.text()).not.toContain('Account:');
    expect(wrapper.text()).not.toContain('Status:');
    expect(wrapper.text()).not.toContain('Platform:');
    for (const label of ['Account', 'Status', 'Platform']) {
      expect(wrapper.find(`select[aria-label="${label}"]`).exists()).toBe(true);
    }
    expect(wrapper.find('select[aria-label="Environment"]').exists()).toBe(false);

    wrapper.unmount();
  });

  it('renders the Environment filter only when two incident environments and rollups are ready', async () => {
    mocks.route.query = { project_id: 'p1' };
    window.history.replaceState({}, '', '/?project_id=p1');
    mocks.listEnvironments.mockResolvedValue({
    environments: [
      { id: 'env-1', name: 'Production' },
      { id: 'env-2', name: 'Staging' },
    ],
      rollup_ready: true,
    });
    mocks.listIncidents.mockResolvedValue([]);

    const wrapper = mountFeed();
    await flushPromises();

    expect(wrapper.find('select[aria-label="Environment"]').exists()).toBe(true);
    expect(mocks.listEnvironments).toHaveBeenCalledWith('p1', 'incidents');

    wrapper.unmount();
  });

  it('renders singular and plural issue counts below the list', async () => {
    mocks.route.query = { project_id: 'p1' };
    window.history.replaceState({}, '', '/?project_id=p1');
    mocks.listIncidents.mockResolvedValue([incident('a', 'One', 'javascript')]);

    let wrapper = mountFeed();
    await flushPromises();
    expect(wrapper.text()).toContain('1 issue');
    expect(wrapper.text()).not.toContain('1 issues');
    wrapper.unmount();

    mocks.listIncidents.mockResolvedValue([
      incident('a', 'One', 'javascript'),
      incident('b', 'Two', 'javascript'),
    ]);
    wrapper = mountFeed();
    await flushPromises();
    expect(wrapper.text()).toContain('2 issues');
    wrapper.unmount();
  });

  it('renders the unfiltered empty state with its Setup guide action', async () => {
    mocks.route.query = { project_id: 'p1' };
    window.history.replaceState({}, '', '/?project_id=p1');
    mocks.listIncidents.mockResolvedValue([]);

    const wrapper = mountFeed();
    await flushPromises();

    expect(wrapper.text()).toContain('No issues yet');
    expect(wrapper.text()).toContain('Setup guide');
    expect(wrapper.find('table').exists()).toBe(false);

    wrapper.unmount();
  });

  it('renders a filtered empty state and clears controls plus URL filters', async () => {
    mocks.route.query = { project_id: 'p1', status: 'merged', platform: 'python' };
    window.history.replaceState({}, '', '/?project_id=p1&status=merged&platform=python');
    mocks.listIncidents.mockResolvedValue([]);

    const wrapper = mountFeed();
    await flushPromises();

    expect(wrapper.text()).toContain('No issues match these filters');
    expect(wrapper.text()).not.toContain('Setup guide');
    await wrapper.get('button').trigger('click');
    await flushPromises();

    expect((wrapper.get('select[aria-label="Status"]').element as HTMLSelectElement).value).toBe('');
    expect((wrapper.get('select[aria-label="Platform"]').element as HTMLSelectElement).value).toBe('');
    expect(mocks.replace).toHaveBeenLastCalledWith({ query: { project_id: 'p1' } });
    expect(mocks.listIncidents).toHaveBeenLastCalledWith('p1', {});

    wrapper.unmount();
  });

  it('renders an error alert when the issue fetch fails', async () => {
    mocks.route.query = { project_id: 'p1' };
    window.history.replaceState({}, '', '/?project_id=p1');
    mocks.listIncidents.mockRejectedValue(new Error('boom'));

    const wrapper = mountFeed();
    await flushPromises();

    expect(wrapper.text()).toContain('Unable to load issues');
    expect(wrapper.text()).toContain('boom');
    expect(wrapper.find('table').exists()).toBe(false);

    wrapper.unmount();
  });

  it('renders skeleton rows while loading', async () => {
    mocks.route.query = { project_id: 'p1' };
    window.history.replaceState({}, '', '/?project_id=p1');
    mocks.listIncidents.mockImplementation(() => new Promise(() => {}));

    const wrapper = mountFeed();
    await flushPromises();

    expect(wrapper.get('[role="status"]').attributes('aria-busy')).toBe('true');
    expect(wrapper.find('table').exists()).toBe(false);

    wrapper.unmount();
  });

  it('renders a stacked list and mobile sort control below the sm breakpoint', async () => {
    mocks.route.query = { project_id: 'p1' };
    window.history.replaceState({}, '', '/?project_id=p1');
    mocks.listIncidents.mockResolvedValue([incident('a', 'Boom', 'javascript')]);

    const wrapper = mountFeed();
    await flushPromises();

    expect(wrapper.get('[data-testid="stacked-issues-list"]').classes()).toContain('sm:hidden');
    expect(wrapper.get('[data-testid="stacked-issue"]').element.tagName).toBe('ARTICLE');
    expect(wrapper.get('select[aria-label="Sort issues"]').classes()).toContain('max-md:min-h-11');

    wrapper.unmount();
  });
});

describe('IssuesList archived escape hatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listAccounts.mockResolvedValue([]);
    mocks.listEnvironments.mockResolvedValue({ environments: [], rollup_ready: false });
    mocks.route.query = {};
    window.history.replaceState({}, '', '/');
  });

  it('offers the archived view from an empty filtered feed and keeps the other filters', async () => {
    mocks.route.query = { project_id: 'p1', platform: 'python' };
    window.history.replaceState({}, '', '/?project_id=p1&platform=python');
    mocks.listIncidents.mockResolvedValue([]);

    const wrapper = mountFeed();
    await flushPromises();

    expect(mocks.listIncidents).toHaveBeenCalledWith('p1', { platform: 'python' });

    await wrapper.get('[data-testid="view-archived"]').trigger('click');
    await flushPromises();

    // Assert on the request, not the rendered text: the point of the link is
    // the filter it applies, and it must not discard the platform filter.
    expect(mocks.listIncidents).toHaveBeenLastCalledWith('p1', {
      platform: 'python',
      status: 'archived',
    });

    // The URL must follow too, or a reload drops the user back to the
    // default view with no way to tell what happened.
    expect(mocks.replace).toHaveBeenCalledWith({
      query: {
        project_id: 'p1',
        platform: 'python',
        status: 'archived',
      },
    });

    wrapper.unmount();
  });

  it('offers the archived view from a wholly empty feed', async () => {
    mocks.route.query = { project_id: 'p1' };
    window.history.replaceState({}, '', '/?project_id=p1');
    mocks.listIncidents.mockResolvedValue([]);

    const wrapper = mountFeed();
    await flushPromises();

    expect(wrapper.find('[data-testid="view-archived"]').exists()).toBe(true);

    wrapper.unmount();
  });

  it('does not offer the archived view when already viewing archived', async () => {
    mocks.route.query = { project_id: 'p1', status: 'archived' };
    window.history.replaceState({}, '', '/?project_id=p1&status=archived');
    mocks.listIncidents.mockResolvedValue([]);

    const wrapper = mountFeed();
    await flushPromises();

    expect(mocks.listIncidents).toHaveBeenCalledWith('p1', { status: 'archived' });
    expect(wrapper.find('[data-testid="view-archived"]').exists()).toBe(false);

    wrapper.unmount();
  });
});
