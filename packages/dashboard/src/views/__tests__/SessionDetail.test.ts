// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import type { SessionDetail as SessionDetailData } from '../../types/api';

const playback = vi.hoisted(() => ({
  useSessionPlayback: vi.fn(),
}));
const api = vi.hoisted(() => ({ getSessionNarrative: vi.fn() }));

vi.mock('../../composables/useSessionPlayback', () => playback);
vi.mock('../../api', () => api);

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { sessionId: 'session-1' }, query: {} }),
}));

import SessionDetail from '../SessionDetail.vue';

const startedAt = '2026-07-22T20:00:00.000Z';

function mountView(durationSeconds: number) {
  const session: SessionDetailData = {
    id: 'session-1',
    started_at: startedAt,
    last_chunk_at: new Date(new Date(startedAt).getTime() + durationSeconds * 1_000).toISOString(),
    status: 'analyzed',
    chunk_count: 1,
    playable_chunk_count: 1,
    bytes_stored: 1_024,
    error_count: 0,
    rage_click_count: 0,
    dead_click_count: 0,
    form_abandon_count: 0,
    coverage: 'complete',
    activity_class: 'active',
    failed_request_count: 0,
    successful_write_count: 0,
    unverified_signal_count: 0,
    chunks: [],
  };

  playback.useSessionPlayback.mockReturnValue({
    state: ref('ready'),
    session: ref(session),
    segments: ref([]),
    activeSegment: ref(0),
    events: ref([]),
    seekMs: ref(undefined),
    missingChunks: ref({ missing: 0, total: 0 }),
    approximate: ref(false),
    pollAttempt: ref(0),
    pollsRemaining: ref(24),
    terminalUnavailable: ref(false),
    error: ref(''),
    loadSegment: vi.fn(),
    stopPolling: vi.fn(),
  });

  return mount(SessionDetail, {
    global: {
      stubs: {
        ReplayPlayer: true,
        RouterLink: { props: ['to'], template: '<a :href="(to.query && to.query.t) || \'\'"><slot /></a>' },
      },
    },
  });
}

function renderedDuration(durationSeconds: number): string {
  const wrapper = mountView(durationSeconds);
  const detail = wrapper.findAll('dl > div').find((row) => row.get('dt').text() === 'Duration');
  const value = detail?.get('dd').text() ?? '';
  wrapper.unmount();
  return value;
}

describe('SessionDetail duration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
	api.getSessionNarrative.mockRejectedValue(new Error('not found'));
  });

  it('uses the canonical duration formatting for long and sub-second sessions', () => {
    expect(renderedDuration(7_230)).toBe('2h 0m');
    expect(renderedDuration(0.4)).toBe('<1s');
  });

	it('renders a corrected narrative observation as text with a cited-moment link', async () => {
		api.getSessionNarrative.mockResolvedValue({
			userGoal: 'Save an asset', narrative: 'The user could not tell whether saving worked.', notable: true,
			observations: [{ id: '0-abcd', category: 'no_feedback_after_action', what: 'No feedback appeared.', severity: 'high', evidenceLines: ['L2'], grade: 'corrected', replacementWhat: 'Feedback appeared late.', atMs: 1700000001234 }],
		});
		const wrapper = mountView(12);
		await flushPromises();
		expect(wrapper.get('[aria-label="Session narrative"]').text()).toContain('Feedback appeared late.');
		expect(wrapper.get('[aria-label="Session narrative"] a').attributes('href')).toBe('1700000001234');
		wrapper.unmount();
	});

	it('explains why observations are ungraded when frame verification failed', async () => {
		api.getSessionNarrative.mockResolvedValue({
			userGoal: 'Save an asset', narrative: 'The user could not tell whether saving worked.', notable: true,
			verificationReason: 'frame capture failed: chromium crashed: SIGTRAP',
			observations: [{ id: '0-abcd', category: 'no_feedback_after_action', what: 'No feedback appeared.', severity: 'high', evidenceLines: ['L2'] }],
		});
		const wrapper = mountView(12);
		await flushPromises();
		expect(wrapper.get('[aria-label="Frame verification unavailable"]').text())
			.toContain('chromium crashed: SIGTRAP');
		wrapper.unmount();
	});
});
