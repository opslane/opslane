-- Optional, owner-invoked, one-shot restamp. Run only after the C4 deploy has
-- completed and before the next 09:00 local digest when legacy receipts should
-- be announced once.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM applied_data_migrations WHERE name = 'c4_backfill_restamp'
  ) THEN
    UPDATE digest_readiness
       SET updated_at = now()
     WHERE status = 'eligible' AND reason LIKE 'backfill_%';

    INSERT INTO applied_data_migrations (name) VALUES ('c4_backfill_restamp');
  END IF;
END
$$;
