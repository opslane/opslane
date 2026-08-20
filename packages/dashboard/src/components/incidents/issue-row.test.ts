// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { Incident } from '../../types/api';
import IssueRow from './IssueRow.vue';

function incident(overrides: Partial<Incident> = {}): Incident {
  return {
    id: 'i1',
    project_id: 'p1',
    kind: 'error',
    platform: 'javascript',
    fingerprint: 'f37814ba355f3df260ec891e3e343433',
    title: "TypeError: Cannot destructure property 'name'",
    status: 'new',
    first_seen: '2026-07-15T12:00:00Z',
    last_seen: '2026-07-17T12:00:00Z',
    occurrence_count: 12_842,
    affected_users_count: 312,
    story: '12842 crashes; recording impact unavailable',
    ...overrides,
  };
}

function mountRow(
  overrides: Partial<Incident> = {},
  props: { showPlatform?: boolean; layout?: 'table' | 'stacked' } = {},
) {
  return mount(IssueRow, {
    props: {
      incident: incident(overrides),
      projectId: 'p1',
      ...props,
    },
    global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
  });
}

describe('IssueRow', () => {
  it('does not render the fingerprint hash', () => {
    expect(mountRow().text()).not.toContain('f37814ba355f3df260ec891e3e343433');
  });

  it('hides the kind marker when the kind is the default error', () => {
    expect(mountRow().find('[data-testid="kind-marker"]').exists()).toBe(false);
  });

  it('shows the kind marker for friction', () => {
    expect(mountRow({ kind: 'friction', platform: null })
      .get('[data-testid="kind-marker"]').text()).toBe('Friction');
  });

  it('shows the unchecked adjudication marker', () => {
    expect(mountRow({
      kind: 'friction',
      adjudication_status: 'unchecked',
      platform: null,
    }).get('[data-testid="kind-marker"]').text()).toBe('Unchecked');
  });

  it('only renders the platform marker when the parent says platforms vary', () => {
    expect(mountRow().find('[data-testid="platform-marker"]').exists()).toBe(false);
    expect(mountRow({}, { showPlatform: true })
      .get('[data-testid="platform-marker"]').text()).toBe('JavaScript');
  });

  it('renders the six desktop cells with formatted counts', () => {
    const row = mountRow();
    expect(row.findAll('td')).toHaveLength(6);
    expect(row.text()).toContain('12,842');
    expect(row.text()).toContain('312');
  });

  it('renders a visibly linked status for a valid GitHub pr_url', () => {
    const link = mountRow({
      status: 'pr_draft',
      pr_url: 'https://github.com/acme/web/pull/42',
    }).get('a[data-testid="pr-link"]');

    expect(link.attributes('href')).toBe('https://github.com/acme/web/pull/42');
    expect(link.attributes('rel')).toContain('noopener');
    expect(link.attributes('target')).toBe('_blank');
    expect(link.attributes('aria-label')).toContain('opens pull request on GitHub');
    expect(link.text()).toContain('↗');
  });

  it.each([
    ['no URL', undefined],
    ['a hostile protocol', 'javascript:alert(1)'],
    ['a non-GitHub host', 'https://gitlab.com/a/b/-/merge_requests/1'],
  ])('renders status as plain text with no arrow for %s', (_label, prUrl) => {
    const row = mountRow({ status: 'pr_draft', pr_url: prUrl });
    expect(row.find('a[data-testid="pr-link"]').exists()).toBe(false);
    expect(row.text()).toContain('Draft PR');
    expect(row.text()).not.toContain('↗');
  });

  it('derives the age cell from first_seen, not last_seen', () => {
    const age = mountRow({
      first_seen: new Date(Date.now() - 400 * 86_400_000).toISOString(),
      last_seen: new Date(Date.now() - 86_400_000).toISOString(),
    }).get('[data-testid="age"]').text();
    expect(age).toBe('1y');
  });

  it('renders relative last-seen exactly once', () => {
    const row = mountRow();
    expect(row.findAll('[data-testid="last-seen"]')).toHaveLength(1);
    expect(row.text()).not.toContain('Last seen');
  });

  it('shows the review time and cited observations for a decline', () => {
    const row = mountRow({
      state: 'reviewed_not_pursuing',
      state_reason: 'Browser extension noise',
      state_decided_at: '2026-08-20T05:25:11Z',
      evidence_event_ids: ['aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000002'],
    }, { layout: 'stacked' });
    const detail = row.get('[data-testid="review-detail"]').text();
    expect(detail).toContain('Reviewed ');
    expect(detail).toContain('cites 2 observations');
  });

  it('shows the pipeline reason and offers another review after a decline', () => {
    const row = mountRow({
      state: 'reviewed_not_pursuing',
      state_reason: 'Browser extension noise',
    }, { layout: 'stacked' });
    expect(row.text()).toContain('Reviewed, not pursuing');
    expect(row.text()).toContain('Browser extension noise');
    expect(row.get('button').text()).toBe('Review again');
  });

  it('renders a pending capture without a broken issue link', () => {
    const row = mountRow({
      pending_identity: true,
      state: 'processing',
      state_reason: 'Working out which problem this belongs to',
    }, { layout: 'stacked' });
    expect(row.find('a').exists()).toBe(false);
    expect(row.text()).toContain('Processing');
  });

  it('renders the mobile layout as a stacked issue with status, users, and age', () => {
    const row = mountRow({}, { layout: 'stacked' });
    expect(row.get('[data-testid="stacked-issue"]').element.tagName).toBe('ARTICLE');
    expect(row.findAll('td')).toHaveLength(0);
    expect(row.text()).toContain('312 users');
    expect(row.get('[data-testid="age"]').text()).not.toBe('');
    expect(row.get('a').classes()).toContain('line-clamp-2');
    expect(row.get('a').attributes('title')).toBe(incident().title);
  });
});
