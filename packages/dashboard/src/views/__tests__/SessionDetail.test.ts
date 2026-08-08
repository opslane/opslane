// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionDetail as SessionDetailData } from '../../types/api';

const playback = vi.hoisted(() => ({
  useSessionPlayback: vi.fn(),
}));

vi.mock('../../composables/useSessionPlayback', () => playback);

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
        RouterLink: { template: '<a><slot /></a>' },
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
  });

  it('uses the canonical duration formatting for long and sub-second sessions', () => {
    expect(renderedDuration(7_230)).toBe('2h 0m');
    expect(renderedDuration(0.4)).toBe('<1s');
  });
});
