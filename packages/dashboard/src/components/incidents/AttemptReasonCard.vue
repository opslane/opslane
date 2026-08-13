<script setup lang="ts">
// The needs-human reason/remediation card, shared by the receipt section and
// the no-receipt fallback so the two render paths cannot drift.
defineProps<{ reason: { reason_code: string; reason_message: string; remediation: string } }>();
</script>

<template>
  <div
    data-testid="attempt-reason-card"
    class="p-4 bg-warning/10 border border-warning/20 border-l-2 border-l-warning rounded-lg space-y-3"
  >
    <div>
      <p class="text-xs font-medium text-warning uppercase tracking-wide">Reason</p>
      <p class="mt-1 text-sm text-warning font-medium" v-text="reason.reason_message"></p>
    </div>
    <div>
      <p class="text-xs font-medium text-warning uppercase tracking-wide">Remediation</p>
      <pre
        class="mt-1 text-sm bg-surface border border-border p-3 rounded overflow-x-auto whitespace-pre-wrap text-text"
        v-text="reason.remediation"
      ></pre>
    </div>
    <p class="text-xs text-faint">Code: <span v-text="reason.reason_code"></span></p>
  </div>
</template>
