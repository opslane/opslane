<script setup lang="ts">
// The saved working diff from a failed fix attempt. Rendered inside the
// receipt section when readiness grants receipt framing, and standalone when
// it does not — the diff is a preserved artifact fact either way (C2 AC2.10:
// the terminal diff stays readable from the incident page).
defineProps<{ diff: string }>();
</script>

<template>
  <div
    data-testid="candidate-diff-card"
    class="p-4 bg-surface border border-border rounded-lg space-y-2"
  >
    <p class="text-xs font-medium text-muted uppercase tracking-wide">Candidate diff</p>
    <pre
      class="text-xs bg-surface border border-border p-3 rounded overflow-x-auto whitespace-pre text-text max-h-96"
      v-text="diff"
    ></pre>
  </div>
</template>
