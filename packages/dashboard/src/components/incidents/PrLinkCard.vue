<script setup lang="ts">
import { computed } from 'vue';
import { GITHUB_PR_URL_OPTIONS, safeUrl } from '../../utils';

// One card for the fix PR artifact, shared by the receipt section and the
// no-receipt fallback so the two paths cannot drift. When the URL fails the
// dashboard's link policy (e.g. a GitHub Enterprise host), the card still
// states the PR and shows the URL as plain text — telling the user a PR is
// ready while hiding every way to reach it is worse than an unlinked URL.
const props = defineProps<{ status: string; prUrl: string }>();
const prHref = computed(() => safeUrl(props.prUrl, GITHUB_PR_URL_OPTIONS));
const isDraft = computed(() => props.status === 'pr_draft');
</script>

<template>
  <div
    data-testid="pr-link-card"
    class="p-4 border border-l-2 rounded-lg"
    :class="isDraft
      ? 'bg-warning/10 border-warning/20 border-l-warning'
      : 'bg-success/10 border-success/20 border-l-success'"
  >
    <p
      class="text-sm font-medium"
      :class="isDraft ? 'text-warning' : 'text-success'"
    >
      {{ isDraft ? 'Draft fix PR — verification pending' : 'Fix PR ready for review' }}
    </p>
    <p v-if="isDraft" class="mt-1 text-xs text-warning">
      Opslane did not reach the ready-for-review evidence bar locally. Review the repository CI results before marking this PR ready.
    </p>
    <a
      v-if="prHref"
      :href="prHref"
      target="_blank"
      rel="noopener noreferrer"
      class="mt-1 inline-flex items-center font-medium hover:underline text-sm"
      :class="isDraft ? 'text-warning' : 'text-success'"
      v-text="prHref"
    ></a>
    <p v-else class="mt-1 text-xs text-muted">
      This host is outside the dashboard's link policy — copy the address:
      <code class="text-text" v-text="prUrl"></code>
    </p>
  </div>
</template>
