<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { agentGitHubInstallUrl, APIError } from '../api';
import CopyButton from '../components/CopyButton.vue';
import { GITHUB_PR_URL_OPTIONS, safeUrl } from '../utils';

const props = defineProps<{ navigate?: (target: string) => void }>();
const route = useRoute();
type Phase = 'redirecting' | 'needs-admin' | 'error';
const phase = ref<Phase>('redirecting');
const message = ref('Taking you to GitHub…');
const pageUrl = window.location.href;

const KNOWN_ERRORS: Record<string, string> = {
  session_ended: 'This setup session has ended. Ask the agent to run setup again.',
  session_not_provisioned: 'Approve the setup in Opslane first, then open this link again.',
  foreign_org: 'This setup belongs to another organization.',
  github_app_not_configured: 'This Opslane has no GitHub App. Connect a repository from Settings with a token instead.',
};

onMounted(async () => {
  try {
    const { install_url } = await agentGitHubInstallUrl(String(route.params.id));
    const target = safeUrl(install_url, GITHUB_PR_URL_OPTIONS);
    if (!target) {
      phase.value = 'error';
      message.value = 'Opslane returned an unexpected install link.';
      return;
    }
    (props.navigate ?? window.location.assign.bind(window.location))(target);
  } catch (err) {
    if (err instanceof APIError && err.status === 403 && err.code !== 'foreign_org') {
      phase.value = 'needs-admin';
      message.value = 'Installing the GitHub App needs an organization admin. Send an admin this link; they will be asked to sign in to Opslane first:';
      return;
    }
    phase.value = 'error';
    message.value = (err instanceof APIError && err.code && KNOWN_ERRORS[err.code])
      || (err instanceof Error ? err.message : 'Could not start the GitHub installation.');
  }
});
</script>

<template>
  <div class="min-h-screen bg-background flex items-center justify-center px-6">
    <div class="max-w-lg w-full rounded-lg border border-border bg-surface p-8" data-testid="agent-github-install">
      <h1 class="text-lg font-medium text-text">Connect GitHub</h1>
      <p
        class="mt-3 text-sm"
        :class="phase === 'error' ? 'text-danger' : 'text-text'"
        :role="phase === 'error' ? 'alert' : 'status'"
        aria-live="polite"
        v-text="message"
      ></p>
      <div v-if="phase === 'needs-admin'" class="mt-3 flex items-start gap-2">
        <code class="flex-1 break-all text-xs text-text" data-testid="agent-github-install-link">{{ pageUrl }}</code>
        <CopyButton :text="pageUrl" />
      </div>
      <router-link v-if="phase === 'error'" to="/" class="mt-6 inline-block text-sm text-accent underline">Back to Opslane</router-link>
    </div>
  </div>
</template>
