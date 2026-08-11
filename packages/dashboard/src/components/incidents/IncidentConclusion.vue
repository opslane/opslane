<script setup lang="ts">
import { computed } from 'vue';
import type { Incident } from '../../types/api';
import { GITHUB_PR_URL_OPTIONS, safeUrl } from '../../utils';

const props = defineProps<{ incident: Incident }>();

const title = computed(() => {
  switch (props.incident.status) {
    case 'needs_human': return 'Human review required';
    case 'pr_created': return 'Fix ready for review';
    case 'pr_draft': return 'Draft fix available';
    case 'resolved': return 'Incident resolved';
    case 'merged': return 'Fix merged';
    case 'insight': return 'Investigation conclusion';
    default: return 'Current conclusion';
  }
});

const prUrl = computed(() => safeUrl(props.incident.pr_url, GITHUB_PR_URL_OPTIONS));
const causeHidden = computed(() =>
  props.incident.investigation_readiness === 'ineligible'
  || props.incident.investigation_readiness === 'pending',
);
</script>

<template>
  <aside class="incident-conclusion border border-border-strong bg-surface p-5" aria-labelledby="conclusion-heading">
    <p class="text-xs font-semibold uppercase tracking-[0.16em] text-accent">Outcome</p>
    <h2 id="conclusion-heading" class="mt-2 text-lg font-semibold text-text" v-text="title"></h2>

    <p v-if="causeHidden" class="mt-4 text-sm text-text">Investigation has not verified a cause yet.</p>

    <dl v-if="incident.confidence && !causeHidden" class="mt-4 border-t border-border pt-3 text-sm">
      <div class="flex justify-between gap-4">
        <dt class="text-muted">Confidence</dt>
        <dd class="font-medium capitalize text-text" v-text="incident.confidence"></dd>
      </div>
    </dl>

    <div v-if="incident.root_cause && !causeHidden" class="mt-5">
      <h3 class="text-xs font-semibold uppercase tracking-wide text-muted">Root cause</h3>
      <p class="mt-2 whitespace-pre-wrap text-sm leading-6 text-text" v-text="incident.root_cause"></p>
    </div>

    <div v-if="incident.suggested_mitigation && !causeHidden" class="mt-5">
      <h3 class="text-xs font-semibold uppercase tracking-wide text-muted">Suggested mitigation</h3>
      <p class="mt-2 whitespace-pre-wrap text-sm leading-6 text-text" v-text="incident.suggested_mitigation"></p>
    </div>

    <div v-if="incident.reason" class="mt-5 border-l-2 border-warning pl-3">
      <p class="text-sm font-semibold text-warning" v-text="incident.reason.reason_message"></p>
      <p class="mt-2 whitespace-pre-wrap text-sm leading-6 text-text" v-text="incident.reason.remediation"></p>
      <p class="mt-2 font-mono text-xs text-muted">{{ incident.reason.reason_code }}</p>
    </div>

    <a
      v-if="prUrl"
      :href="prUrl"
      target="_blank"
      rel="noopener noreferrer"
      class="mt-5 inline-flex min-h-10 items-center border-b-2 border-accent text-sm font-semibold text-text hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >Open pull request <span aria-hidden="true" class="ml-2">↗</span></a>

    <div class="mt-5 border-t border-border pt-4">
      <slot name="actions" />
    </div>
  </aside>
</template>
