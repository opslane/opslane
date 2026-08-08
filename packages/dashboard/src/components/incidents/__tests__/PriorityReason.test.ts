// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { Incident, PriorityInputs } from '../../../types/api';
import PriorityReason from '../PriorityReason.vue';

function inputs(overrides: Partial<PriorityInputs> = {}): PriorityInputs {
  return {
    users_7d: 14,
    anon_sessions_7d: 6,
    users_24h: 0,
    anon_sessions_24h: 0,
    impact: 20,
    route_pattern: null,
    route_name: null,
    route_tier: null,
    route_weight: 1,
    cap_applied: false,
    reason_code: null,
    ...overrides,
  };
}

function incident(overrides: Partial<Incident> = {}): Incident {
  return {
    id: 'i1',
    project_id: 'p1',
    kind: 'error',
    fingerprint: 'fingerprint-i1',
    title: 'Checkout failed',
    status: 'new',
    first_seen: '2026-08-01T00:00:00Z',
    last_seen: '2026-08-07T00:00:00Z',
    occurrence_count: 20,
    affected_users_count: 14,
    priority_score: 20,
    priority_scored_at: '2026-08-07T01:00:00Z',
    priority_inputs: inputs(),
    ...overrides,
  };
}

function render(
  incidentOverrides: Partial<Incident> = {},
  props: { environmentFiltered?: boolean; projectHasIdentify?: boolean } = {},
) {
  return mount(PriorityReason, {
    props: {
      incident: incident(incidentOverrides),
      environmentFiltered: props.environmentFiltered ?? false,
      projectHasIdentify: props.projectHasIdentify ?? false,
    },
  });
}

describe('PriorityReason', () => {
  it('renders known users and anonymous sessions', () => {
    expect(render().text()).toContain('14 known users + 6 anonymous sessions this week');
  });

  it('omits the zero side and appends today count', () => {
    const wrapper = render({
      priority_inputs: inputs({
        anon_sessions_7d: 0,
        users_24h: 2,
      }),
    });

    expect(wrapper.text()).toContain('14 known users this week · 2 today');
    expect(wrapper.text()).not.toContain('anonymous sessions this week');
  });

  it('labels project-wide reach under an environment filter', () => {
    expect(render({}, { environmentFiltered: true }).text())
      .toContain('14 known users + 6 anonymous sessions this week · project-wide');
  });

  it('shows the identify hint for anonymous-only reach', () => {
    const wrapper = render({
      priority_inputs: inputs({ users_7d: 0, anon_sessions_7d: 9 }),
    });

    expect(wrapper.text()).toContain('No user identification on this page — counting sessions.');
  });

  it('shows the identify hint for anonymous-majority mixed reach', () => {
    const wrapper = render({
      priority_inputs: inputs({ users_7d: 2, anon_sessions_7d: 14 }),
    });

    expect(wrapper.text()).toContain('No user identification on this page — counting sessions.');
  });

  it('hides the identify hint for known-majority mixed reach', () => {
    expect(render().text()).not.toContain('No user identification on this page');
  });

  it('upgrades the hint when the project has identify elsewhere', () => {
    const wrapper = render(
      { priority_inputs: inputs({ users_7d: 2, anon_sessions_7d: 14 }) },
      { projectHasIdentify: true },
    );

    expect(wrapper.text()).toContain('identify() is wired elsewhere in your app but not on this page.');
  });

  it('shows remediation for capped incidents', () => {
    const wrapper = render({
      priority_inputs: inputs({ cap_applied: true, reason_code: 'unfixable_third_party' }),
      reason: {
        reason_code: 'unfixable_third_party',
        reason_message: 'Third-party failure',
        remediation: 'Upgrade the vendor package.',
      },
    });

    expect(wrapper.text()).toContain("The agent can't fix this class (ranked down).");
    expect(wrapper.text()).toContain('Upgrade the vendor package.');
  });

  it('renders the bare route pattern when no route name exists', () => {
    const wrapper = render({
      priority_inputs: inputs({ route_pattern: '/assets/:id' }),
    });

    expect(wrapper.text()).toContain('/assets/:id');
  });

  it('shows "not scored yet" when priority fields are absent', () => {
    const wrapper = render({
      priority_score: undefined,
      priority_scored_at: undefined,
      priority_inputs: undefined,
    });

    expect(wrapper.text()).toContain('Not scored yet');
  });

  it('renders quiet scored issues distinctly from unscored issues', () => {
    const wrapper = render({
      priority_score: 0,
      priority_inputs: inputs({
        users_7d: 0,
        anon_sessions_7d: 0,
        impact: 0,
      }),
    });

    expect(wrapper.text()).toContain('Quiet this week');
    expect(wrapper.text()).not.toContain('Not scored yet');
  });

  it.each([
    ['customer', 'Customer portal · your customers see this page'],
    ['admin', 'Customer portal · internal config page'],
  ] as const)('labels %s routes with their audience', (routeTier, expected) => {
    const wrapper = render({
      priority_inputs: inputs({
        route_name: 'Customer portal',
        route_pattern: '/portal',
        route_tier: routeTier,
      }),
    });

    expect(wrapper.text()).toContain(expected);
  });

  it.each(['standard', null] as const)('does not add an audience suffix for %s routes', (routeTier) => {
    const wrapper = render({
      priority_inputs: inputs({
        route_name: 'Issue detail',
        route_pattern: '/issues/:id',
        route_tier: routeTier,
      }),
    });

    expect(wrapper.text()).toContain('Issue detail');
    expect(wrapper.text()).not.toContain('your customers see this page');
    expect(wrapper.text()).not.toContain('internal config page');
  });
});
