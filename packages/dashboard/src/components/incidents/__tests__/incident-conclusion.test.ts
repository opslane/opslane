// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { Incident } from '../../../types/api';
import IncidentConclusion from '../IncidentConclusion.vue';

const base: Incident = {
  id: 'i1', project_id: 'p1', kind: 'error', fingerprint: 'fp', title: 'Crash',
  status: 'investigated', first_seen: '2026-08-11T00:00:00Z', last_seen: '2026-08-11T00:00:00Z',
  occurrence_count: 1, affected_users_count: 1, confidence: 'high',
  root_cause: 'placeholder', suggested_mitigation: 'change it',
};

describe('IncidentConclusion honest state', () => {
  it('hides model output and confidence for ineligible incidents', () => {
    const wrapper = mount(IncidentConclusion, { props: { incident: { ...base, investigation_readiness: 'ineligible' } } });
    expect(wrapper.text()).toContain('Investigation has not verified a cause yet.');
    expect(wrapper.text()).not.toContain('placeholder');
    expect(wrapper.text()).not.toContain('change it');
    expect(wrapper.text()).not.toContain('Confidence');
  });

  it('preserves legacy absent-row rendering', () => {
    expect(mount(IncidentConclusion, { props: { incident: base } }).text()).toContain('placeholder');
  });

  it('renders eligible output normally', () => {
    expect(mount(IncidentConclusion, { props: { incident: { ...base, investigation_readiness: 'eligible' } } }).text()).toContain('placeholder');
  });
});
