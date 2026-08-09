import type pg from 'pg';

/** A previous test run that died mid-file leaks its tenant (cleanup is
 * scoped to that run's project id). Purging same-named orgs at suite start
 * makes leaks self-heal instead of poisoning global-queue assertions in
 * other suites (claimJob and lane history read across every tenant). */
export async function purgeStaleTenants(pool: pg.Pool, orgName: string): Promise<void> {
  const orgScope = `(SELECT id FROM projects WHERE org_id IN (SELECT id FROM orgs WHERE name = $1))`;
  await pool.query(
    `UPDATE friction_adjudication_generations SET representative_signal_id = NULL
     WHERE project_id IN ${orgScope}`,
    [orgName],
  );
  await pool.query(
    `UPDATE error_groups SET representative_signal_id = NULL WHERE project_id IN ${orgScope}`,
    [orgName],
  );
  await pool.query(`DELETE FROM friction_signals WHERE project_id IN ${orgScope}`, [orgName]);
  // Both reference friction_adjudication_generations, so they go first.
  // last_generation_id is ON DELETE SET NULL and the evidence FKs cascade, so
  // this is belt-and-braces for generations, but friction_bucket_state also
  // references projects and environments without a cascade, so purging it
  // explicitly is what keeps bucket state from outliving its project.
  await pool.query(
    `DELETE FROM friction_generation_evidence WHERE project_id IN ${orgScope}`,
    [orgName],
  );
  await pool.query(`DELETE FROM friction_bucket_state WHERE project_id IN ${orgScope}`, [orgName]);
  await pool.query(
    `DELETE FROM friction_adjudication_generations WHERE project_id IN ${orgScope}`,
    [orgName],
  );
  await pool.query(`DELETE FROM error_group_jobs WHERE project_id IN ${orgScope}`, [orgName]);
  await pool.query(`DELETE FROM error_events WHERE project_id IN ${orgScope}`, [orgName]);
  await pool.query(
    `DELETE FROM error_group_affected_users WHERE error_group_id IN
       (SELECT id FROM error_groups WHERE project_id IN ${orgScope})`,
    [orgName],
  );
  await pool.query(`DELETE FROM error_groups WHERE project_id IN ${orgScope}`, [orgName]);
  await pool.query(`DELETE FROM sessions WHERE project_id IN ${orgScope}`, [orgName]);
  await pool.query(`DELETE FROM end_users WHERE project_id IN ${orgScope}`, [orgName]);
  await pool.query(`DELETE FROM environments WHERE project_id IN ${orgScope}`, [orgName]);
  await pool.query(`DELETE FROM projects WHERE org_id IN (SELECT id FROM orgs WHERE name = $1)`, [
    orgName,
  ]);
  await pool.query(`DELETE FROM orgs WHERE name = $1`, [orgName]);
}
