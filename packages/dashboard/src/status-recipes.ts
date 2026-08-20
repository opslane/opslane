import type { AdminJobStatus, ErrorGroupStatus, IssuePipelineState, SessionStatus } from './types/api';
import type { StatusTone } from './components/ui/StatusLabel.vue';

export interface StatusRecipe {
  label: string;
  tone: StatusTone;
  class: string;
}

const classes: Record<StatusTone, string> = {
  neutral: 'border-border-strong bg-surface-subtle text-muted',
  danger: 'border-danger/30 bg-danger-subtle text-danger',
  success: 'border-success/30 bg-success-subtle text-success',
  warning: 'border-warning/30 bg-warning-subtle text-warning',
  progress: 'border-progress/30 bg-progress-subtle text-progress',
  insight: 'border-insight/30 bg-insight-subtle text-insight',
};

function recipe(label: string, tone: StatusTone): StatusRecipe {
  return { label, tone, class: classes[tone] };
}

/**
 * Runtime guard for values the compile-time union does not know about — a
 * status added server-side (`ALTER TYPE ... ADD VALUE`) before the frontend
 * union catches up, or a corrupt row. The parameter is typed `never`, so a
 * switch that stops being exhaustive still fails the build; this only runs
 * when the wire disagrees with the types. Returning a neutral badge keeps the
 * route rendering instead of throwing on `.class`/`.tone`.
 */
function unknownStatusRecipe(status: never): StatusRecipe {
  const raw = String(status ?? '').trim();
  if (!raw) return recipe('Unknown', 'neutral');
  const text = raw.replace(/_/g, ' ');
  return recipe(text.charAt(0).toUpperCase() + text.slice(1), 'neutral');
}

export function incidentStatusRecipe(status: ErrorGroupStatus): StatusRecipe {
  switch (status) {
    case 'new': return recipe('New', 'neutral');
    case 'queued': return recipe('Queued', 'progress');
    case 'analyzing': return recipe('Analyzing', 'progress');
    case 'investigated': return recipe('Investigated', 'insight');
    case 'fixing': return recipe('Fixing', 'progress');
    case 'pr_draft': return recipe('Draft PR', 'warning');
    case 'pr_created': return recipe('PR Created', 'success');
    case 'needs_human': return recipe('Needs human', 'warning');
    case 'resolved': return recipe('Resolved', 'success');
    case 'merged': return recipe('Merged', 'success');
    case 'archived': return recipe('Archived', 'neutral');
    case 'candidate': return recipe('Candidate', 'neutral');
    case 'awaiting_approval': return recipe('Awaiting approval', 'warning');
    case 'insight': return recipe('Insight', 'insight');
  }
  return unknownStatusRecipe(status);
}

export function pipelineStateRecipe(state: IssuePipelineState): StatusRecipe {
  switch (state) {
    case 'processing': return recipe('Processing', 'progress');
    case 'watching': return recipe('Watching', 'neutral');
    case 'reviewing_evidence': return recipe('Reviewing evidence', 'progress');
    case 'waiting_for_evidence': return recipe('Waiting for evidence', 'warning');
    case 'reviewed_not_pursuing': return recipe('Reviewed, not pursuing', 'neutral');
    case 'investigating': return recipe('Investigating', 'progress');
    case 'fix_ready': return recipe('Fix ready', 'success');
    case 'needs_you': return recipe('Needs you', 'warning');
    case 'inactive': return recipe('Inactive', 'neutral');
    case 'resolved': return recipe('Resolved', 'success');
  }
  return unknownStatusRecipe(state);
}

export function adminJobStatusRecipe(status: AdminJobStatus): StatusRecipe {
  switch (status) {
    case 'pending': return recipe('Pending', 'warning');
    case 'claimed': return recipe('Claimed', 'progress');
    case 'completed': return recipe('Completed', 'success');
    case 'failed': return recipe('Failed', 'danger');
    case 'dead_letter': return recipe('Dead letter', 'danger');
  }
  return unknownStatusRecipe(status);
}

export function sessionStatusRecipe(status: SessionStatus): StatusRecipe {
  switch (status) {
    case 'recording': return recipe('Recording', 'progress');
    case 'closed': return recipe('Closed', 'neutral');
    case 'analyzing': return recipe('Analyzing', 'progress');
    case 'analyzed': return recipe('Analyzed', 'success');
    case 'analysis_failed': return recipe('Analysis failed', 'danger');
    case 'deleting': return recipe('Deleting', 'warning');
  }
  return unknownStatusRecipe(status);
}

export type FrictionSignalKind =
  | 'error'
  | 'rage_click'
  | 'dead_click'
  | 'form_abandon'
  | 'recording'
  | 'queued'
  | 'analyzing'
  | 'analysis_failed';

export function frictionSignalRecipe(kind: FrictionSignalKind, count = 1): StatusRecipe {
  switch (kind) {
    case 'error':
      return recipe(`${count} ${count === 1 ? 'error' : 'errors'}`, 'danger');
    case 'rage_click':
      return recipe(`${count} rage ${count === 1 ? 'click' : 'clicks'}`, 'warning');
    case 'dead_click':
      return recipe(`${count} dead ${count === 1 ? 'click' : 'clicks'}`, 'warning');
    case 'form_abandon':
      return recipe(`${count} form ${count === 1 ? 'abandon' : 'abandons'}`, 'neutral');
    case 'recording':
      return recipe('Recording', 'progress');
    case 'queued':
      return recipe('Queued', 'progress');
    case 'analyzing':
      return recipe('Analyzing', 'progress');
    case 'analysis_failed':
      return recipe('Analysis failed', 'warning');
  }
  return unknownStatusRecipe(kind);
}

export type IncidentKind = 'error' | 'friction';

export function incidentKindRecipe(kind: IncidentKind): StatusRecipe {
  switch (kind) {
    case 'error': return recipe('Error', 'neutral');
    case 'friction': return recipe('Friction', 'insight');
  }
  return unknownStatusRecipe(kind);
}

export type KnownPlatform = 'javascript' | 'python';

export function knownPlatformRecipe(platform: KnownPlatform): StatusRecipe {
  switch (platform) {
    case 'javascript': return recipe('JavaScript', 'neutral');
    case 'python': return recipe('Python', 'neutral');
  }
  return unknownStatusRecipe(platform);
}
