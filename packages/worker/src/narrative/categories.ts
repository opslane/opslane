import type { FrictionCategory } from '@opslane/shared';

export const FRICTION_CATEGORIES: readonly FrictionCategory[] = [
  'unclickable_affordance',
  'no_feedback_after_action',
  'dead_end_state',
  'validation_confusion',
  'slow_response',
  'repetitive_workflow',
  'discoverability_gap',
  'hard_blocker',
  'other',
];

export const ELEMENT_ANCHORED_CATEGORIES: ReadonlySet<FrictionCategory> = new Set([
  'unclickable_affordance',
  'no_feedback_after_action',
  'discoverability_gap',
]);
