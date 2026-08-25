<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { Replayer } from 'rrweb';
import type { eventWithTime } from '@rrweb/types';
import 'rrweb/dist/style.css';
import { crashSeekMs, ensureReplayMeta, formatTime, replayDurationMs, replayViewport, sortedReplayEvents } from './replay-utils';

const props = defineProps<{
  events: eventWithTime[];
  crashTimestamp?: number;
}>();

const SPEEDS = [1, 2, 4, 8];

const containerRef = ref<HTMLDivElement | null>(null);
const replayer = ref<Replayer | null>(null);
const currentTime = ref(0);
const duration = ref(0);
const isPlaying = ref(false);
const speed = ref(1);
const showSpeedMenu = ref(false);
let timer: ReturnType<typeof setInterval> | null = null;

// rrweb renders the replay at the recorded viewport size and draws the cursor in
// recorded coordinates. We scale the whole `.replayer-wrapper` (iframe + cursor
// together) to fit the container instead of stretching the iframe, so a wider
// recording does not reflow and drift the click positions. See replay-utils.
let recordedWidth = 1280;
let recordedHeight = 720;
let resizeObserver: ResizeObserver | null = null;
let appliedSignature = '';
let pendingFrame: number | null = null;

function applyScale() {
  const el = containerRef.value;
  if (!el || recordedWidth <= 0) return;
  const available = el.clientWidth;
  if (available <= 0) return;
  const scale = Math.min(1, available / recordedWidth);
  const height = Math.round(recordedHeight * scale);
  const signature = `${scale}:${height}`;
  if (signature === appliedSignature) return;
  appliedSignature = signature;
  el.style.setProperty('--replay-scale', String(scale));
  el.style.height = `${height}px`;
}

// applyScale writes height on the element the ResizeObserver watches. Deferring
// to the next frame keeps that write out of the observer's own callback, which
// avoids the benign "ResizeObserver loop" console warning on every real resize.
function scheduleScale() {
  if (pendingFrame !== null) return;
  pendingFrame = requestAnimationFrame(() => {
    pendingFrame = null;
    applyScale();
  });
}

function buildPlayer() {
  if (!containerRef.value || !props.events || props.events.length === 0) return;
  containerRef.value.innerHTML = '';

  const events = ensureReplayMeta(sortedReplayEvents(props.events));
  const r = new Replayer(events, {
    root: containerRef.value,
    skipInactive: false,
    showWarning: false,
    blockClass: 'rr-block',
    mouseTail: false,
    speed: speed.value,
  });

  replayer.value = r;

  const viewport = replayViewport(events);
  recordedWidth = viewport.width;
  recordedHeight = viewport.height;
  appliedSignature = '';
  applyScale();
  // The recorded viewport can change mid-session (e.g. a browser resize); rrweb
  // re-lays-out and emits 'resize', so rescale to the new dimensions.
  r.on('resize', (payload) => {
    const dims = payload as { width?: number; height?: number };
    if (dims?.width && dims.width > 0) recordedWidth = dims.width;
    if (dims?.height && dims.height > 0) recordedHeight = dims.height;
    applyScale();
  });
  resizeObserver = new ResizeObserver(() => scheduleScale());
  resizeObserver.observe(containerRef.value);
  const metaTotal = r.getMetaData().totalTime;
  duration.value = Math.max(0, (metaTotal > 0 ? metaTotal : replayDurationMs(events)) / 1000);

  const seekMs = crashSeekMs(events, props.crashTimestamp);
  r.pause(seekMs);
  currentTime.value = seekMs / 1000;

  timer = setInterval(() => {
    const rp = replayer.value;
    if (rp && isPlaying.value) {
      const t = Math.max(0, (rp.getCurrentTime() || 0) / 1000);
      if (!Number.isNaN(t)) currentTime.value = t;
      if (t >= duration.value) isPlaying.value = false;
    }
  }, 100);
}

function destroyPlayer() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
  if (pendingFrame !== null) {
    cancelAnimationFrame(pendingFrame);
    pendingFrame = null;
  }
  appliedSignature = '';
  if (containerRef.value) {
    containerRef.value.style.removeProperty('--replay-scale');
    containerRef.value.style.removeProperty('height');
  }
  if (replayer.value) {
    try {
      replayer.value.pause();
      replayer.value.destroy();
    } catch {
      // rrweb may already be torn down during route changes.
    }
    replayer.value = null;
  }
  if (containerRef.value) containerRef.value.innerHTML = '';
}

function play() {
  const r = replayer.value;
  if (!r) return;
  r.play(Math.max(0, r.getCurrentTime()));
  isPlaying.value = true;
}

function pause() {
  const r = replayer.value;
  if (!r) return;
  r.pause();
  currentTime.value = Math.max(0, r.getCurrentTime() / 1000);
  isPlaying.value = false;
}

function seek(seconds: number) {
  const r = replayer.value;
  if (!r) return;
  const clamped = Math.min(Math.max(0, seconds), duration.value);
  r.pause(clamped * 1000);
  isPlaying.value = false;
  currentTime.value = clamped;
}

function jumpToCrash() {
  seek(crashSeekMs(sortedReplayEvents(props.events), props.crashTimestamp) / 1000);
}

function setSpeed(s: number) {
  speed.value = s;
  showSpeedMenu.value = false;
  replayer.value?.setConfig({ speed: s });
}

onMounted(buildPlayer);
onUnmounted(destroyPlayer);

watch(
  () => props.events,
  () => {
    destroyPlayer();
    buildPlayer();
  }
);
</script>

<template>
  <div class="space-y-3">
    <div ref="containerRef" class="replay-container bg-black/5 rounded-lg overflow-hidden" />
    <div class="flex flex-wrap items-center gap-3">
      <button class="inline-flex min-h-10 items-center justify-center border border-border-strong bg-surface px-4 py-2 text-sm font-semibold text-text hover:bg-surface-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50 text-sm" :disabled="!replayer" @click="isPlaying ? pause() : play()">
        {{ isPlaying ? 'Pause' : 'Play' }}
      </button>
      <button class="inline-flex min-h-10 items-center justify-center border border-border-strong bg-surface px-4 py-2 text-sm font-semibold text-text hover:bg-surface-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50 text-sm" :disabled="!replayer" @click="jumpToCrash">
        Jump to crash
      </button>
      <div class="relative">
        <button class="inline-flex min-h-10 items-center justify-center border border-border-strong bg-surface px-4 py-2 text-sm font-semibold text-text hover:bg-surface-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50 text-sm" :disabled="!replayer" @click="showSpeedMenu = !showSpeedMenu">
          {{ speed }}x
        </button>
        <div v-if="showSpeedMenu" class="absolute bottom-full mb-1 bg-surface border border-border rounded-lg py-1">
          <button
            v-for="s in SPEEDS"
            :key="s"
            class="block w-full px-3 py-1 text-sm text-left hover:bg-border/30"
            :class="{ 'font-semibold': s === speed }"
            @click="setSpeed(s)"
          >
            {{ s }}x
          </button>
        </div>
      </div>
      <input
        type="range"
        class="min-w-48 flex-1"
        :min="0"
        :max="duration"
        :step="0.1"
        :value="currentTime"
        :disabled="!replayer"
        @input="seek(parseFloat(($event.target as HTMLInputElement).value))"
      />
      <span class="text-sm text-muted min-w-[96px] text-right">
        {{ formatTime(currentTime) }} / {{ formatTime(duration) }}
      </span>
    </div>
  </div>
</template>

<style scoped>
/* Height is set to recordedHeight * scale from JS (a CSS transform does not
   affect layout), so no min-height here: a fixed floor would leave dead space
   under a short replay. The template element carries `overflow-hidden`, which
   clips the scaled wrapper. */
/* Scale the whole rrweb wrapper (iframe + cursor overlay) to fit the container
   at the recorded viewport's coordinate space. Do NOT stretch the iframe on its
   own: that reflows a responsive recording and drifts the replayed clicks. */
.replay-container :deep(.replayer-wrapper) {
  transform: scale(var(--replay-scale, 1));
  transform-origin: top left;
}

.replay-container :deep(iframe) {
  border: 0;
}
</style>
