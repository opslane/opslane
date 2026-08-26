<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { getOnboardingState } from '../api';

const githubMissing = ref(false);
const slackMissing = ref(false);

async function refresh(): Promise<void> {
  try {
    const state = await getOnboardingState();
    githubMissing.value = !state.github_connected;
    slackMissing.value = !state.slack_connected;
  } catch {
    // Keep the last good state; a transient failure must not clear a reminder.
  }
}

onMounted(() => {
  void refresh();
  window.addEventListener('opslane-projects-changed', refresh);
  window.addEventListener('opslane-integrations-changed', refresh);
});

onUnmounted(() => {
  window.removeEventListener('opslane-projects-changed', refresh);
  window.removeEventListener('opslane-integrations-changed', refresh);
});
</script>

<template>
  <div v-if="githubMissing || slackMissing" class="space-y-2 px-4 pt-4">
    <div v-if="githubMissing" class="rounded-lg border border-warning/40 bg-warning/10 px-4 py-2 text-sm text-text" role="status">
      Connect GitHub to get automated fix PRs.
      <RouterLink to="/settings" class="underline">Open Settings</RouterLink>
    </div>
    <div v-if="slackMissing" class="rounded-lg border border-warning/40 bg-warning/10 px-4 py-2 text-sm text-text" role="status">
      Connect Slack to get your daily digest.
      <RouterLink to="/settings" class="underline">Open Settings</RouterLink>
    </div>
  </div>
</template>
