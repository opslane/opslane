-- Archive/unarchive must restore terminal diagnosis conclusions: an error group
-- can now terminate at insight, so the pre-archive status has to survive the
-- round trip rather than being inferred back.
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS status_before_archive error_group_status;
