<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { agentGitHubInstallUrl, APIError } from '../api';
import { GITHUB_PR_URL_OPTIONS, safeUrl } from '../utils';

const props = defineProps<{ navigate?: (target: string) => void }>();
const route = useRoute();
const message = ref('Taking you to GitHub…');
const needsAdmin = ref(false);
const pageUrl = window.location.href;

onMounted(async () => {
  try {
    const { install_url } = await agentGitHubInstallUrl(String(route.params.id));
    const target = safeUrl(install_url, GITHUB_PR_URL_OPTIONS);
    if (!target) {
      message.value = 'Opslane returned an unexpected install link.';
      return;
    }
    (props.navigate ?? window.location.assign.bind(window.location))(target);
  } catch (err) {
    if (err instanceof APIError && err.status === 403 && err.code !== 'foreign_org') {
      needsAdmin.value = true;
      message.value = 'Installing the GitHub App needs an organization admin. Send them this link:';
      return;
    }
    message.value = err instanceof Error ? err.message : 'Could not start the GitHub installation.';
  }
});
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-background px-4">
    <div class="max-w-lg w-full rounded-lg border border-border bg-surface p-8" data-testid="agent-github-install">
      <p class="text-sm text-text" v-text="message"></p>
      <code v-if="needsAdmin" class="mt-3 block break-all text-xs text-muted" data-testid="agent-github-install-link">{{ pageUrl }}</code>
    </div>
  </div>
</template>
