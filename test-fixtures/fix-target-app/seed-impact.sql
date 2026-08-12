-- psql variables required: project_id and group_id.
WITH inserted AS (
  INSERT INTO end_users (project_id, external_user_id, display_name)
  VALUES
    (:'project_id'::uuid, 'cp2-user-1', 'CP2 User 1'),
    (:'project_id'::uuid, 'cp2-user-2', 'CP2 User 2')
  ON CONFLICT (project_id, external_user_id) DO UPDATE SET last_seen = now()
  RETURNING id
)
INSERT INTO error_group_affected_users (error_group_id, end_user_id)
SELECT :'group_id'::uuid, id FROM inserted
ON CONFLICT (error_group_id, end_user_id) DO UPDATE SET last_seen = now();
