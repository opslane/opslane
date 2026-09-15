const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** `agent-runs/<project>/<yyyy-mm-dd>/<run>/`, dated by UTC at run start. */
export function runObjectPrefix(projectId: string, runId: string, startedAt: Date): string {
  if (!SAFE_ID.test(projectId) || !SAFE_ID.test(runId)) {
    throw new Error(`invalid run log id: ${projectId}/${runId}`);
  }
  return `agent-runs/${projectId}/${startedAt.toISOString().slice(0, 10)}/${runId}/`;
}
