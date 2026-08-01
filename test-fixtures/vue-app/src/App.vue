<script setup lang="ts">
import { ref } from 'vue';
import UserCard from './components/UserCard.vue';
import AsyncLoader from './components/AsyncLoader.vue';
import WatcherBug from './components/WatcherBug.vue';
import FetchUser from './components/FetchUser.vue';
import FrictionLab from './components/FrictionLab.vue';
import DeadEnd from './components/DeadEnd.vue';
import type { User } from './types';
import { captureException } from '@opslane/sdk';

const currentView = ref<string>('home');
const buggyUser: User = { id: 1, username: 'alice', profile: null };

declare global {
  interface Window {
    __opslaneLastCapturedStack?: string;
  }
}

function captureWithOriginalStack(error: Error): void {
  window.__opslaneLastCapturedStack = error.stack ?? '';
  captureException(error);
}

function triggerEagerDebugError(): void {
  try {
    throw new Error('debug-id eager chunk');
  } catch (error) {
    captureWithOriginalStack(error as Error);
  }
}

async function triggerLazyDebugError(): Promise<void> {
  try {
    await import('./debug-id-lazy');
  } catch (error) {
    captureWithOriginalStack(error as Error);
  }
}

function debugWorker(command: 'capture' | 'forward'): void {
  const worker = new Worker(new URL('./debug-id-worker.ts', import.meta.url), {
    type: 'module',
  });
  worker.addEventListener('message', (event: MessageEvent<{ kind: string; stack: string }>) => {
    if (event.data.kind === 'worker-stack') {
      const forwarded = new Error('debug-id worker forwarded');
      forwarded.stack = event.data.stack;
      captureWithOriginalStack(forwarded);
    } else if (event.data.kind === 'worker-captured') {
      window.__opslaneLastCapturedStack = event.data.stack;
      // Let the worker's maxBatchSize=1 flush finish before terminating it.
      window.setTimeout(() => worker.terminate(), 500);
      return;
    }
    worker.terminate();
  });
  worker.postMessage(command);
}

function triggerThirdPartyFrame(): void {
  const error = new Error('debug-id third party');
  error.stack = 'Error: debug-id third party\n    at vendor (https://third.example/vendor.js:1:2)';
  captureWithOriginalStack(error);
}

function triggerUnparseableFrame(): void {
  const error = new Error('debug-id unparseable');
  error.stack = 'Error: debug-id unparseable\n    at <anonymous>';
  captureWithOriginalStack(error);
}
</script>

<template>
  <div>
    <nav>
      <button data-testid="nav-home" @click="currentView = 'home'">Home</button>
      <button data-testid="nav-usercard" @click="currentView = 'usercard'">UserCard</button>
      <button data-testid="nav-async" @click="currentView = 'async'">AsyncLoader</button>
      <button data-testid="nav-watcher" @click="currentView = 'watcher'">WatcherBug</button>
      <button data-testid="nav-fetch" @click="currentView = 'fetch'">FetchUser</button>
      <button data-testid="nav-friction" @click="currentView = 'friction'">FrictionLab</button>
      <button data-testid="nav-dead" @click="currentView = 'dead'">DeadEnd</button>
    </nav>
    <main>
      <section data-testid="debug-id-controls">
        <button data-testid="debug-id-eager" @click="triggerEagerDebugError">Debug eager</button>
        <button data-testid="debug-id-lazy" @click="triggerLazyDebugError">Debug lazy</button>
        <button data-testid="debug-id-worker-capture" @click="debugWorker('capture')">Debug worker capture</button>
        <button data-testid="debug-id-worker-forward" @click="debugWorker('forward')">Debug worker forward</button>
        <button data-testid="debug-id-third-party" @click="triggerThirdPartyFrame">Debug third party</button>
        <button data-testid="debug-id-unparseable" @click="triggerUnparseableFrame">Debug unparseable</button>
      </section>
      <p v-if="currentView === 'home'">Select a bug to trigger</p>
      <UserCard v-if="currentView === 'usercard'" :user="buggyUser" />
      <AsyncLoader v-if="currentView === 'async'" />
      <WatcherBug v-if="currentView === 'watcher'" />
      <FetchUser v-if="currentView === 'fetch'" />
      <FrictionLab v-if="currentView === 'friction'" />
      <DeadEnd v-if="currentView === 'dead'" />
    </main>
  </div>
</template>
