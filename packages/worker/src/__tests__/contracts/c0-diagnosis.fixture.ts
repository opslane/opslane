import type {
  Adjudication,
  Diagnosis,
  DiagnosisOutcome,
  EvidenceCitation,
} from '@opslane/shared';

export const citation: EvidenceCitation = {
  path: 'src/components/AuthWrapper.vue',
  detail: 'v-if chain mixes sync and async components',
  symptomLink: 'page dies during sign-in when a status flag flips mid-resolve',
};

export const adjudicationWithEvidence: Adjudication = {
  best_supported: 'The authentication wrapper renders an unresolved component.',
  evidence_check: 'The component branch and reported sign-in path agree.',
  candidates_considered: [
    {
      statement: 'The authentication wrapper mixes sync and async components.',
      kind: 'local_code',
    },
  ],
  rejected: [],
  evidence_strength: 'suggestive',
  cause_kind: 'local_code',
  cause_locations: [{ path: 'src/components/AuthWrapper.vue' }],
  reasoning: 'The failing branch is selected only while authentication resolves.',
  why_chain: ['Authentication status changes', 'An unresolved component renders'],
  reproduction_steps: ['Start sign-in', 'Change authentication status during resolve'],
  evidence: [citation],
  agent_task_brief: 'Fix the auth wrapper component branch and verify sign-in transitions.',
};

export const incompleteOutcome: DiagnosisOutcome = 'incomplete';

export const diagnosisWithEvidence: Diagnosis = {
  one_line_description: 'The authentication wrapper renders an unresolved component.',
  why_chain: ['Authentication status changes', 'An unresolved component renders'],
  reproduction_steps: ['Start sign-in', 'Change authentication status during resolve'],
  cause_location: 'src/components/AuthWrapper.vue',
  evidence: [citation],
  agentTaskBrief: 'Fix the auth wrapper component branch and verify sign-in transitions.',
};
