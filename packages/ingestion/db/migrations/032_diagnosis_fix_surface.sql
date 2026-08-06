-- Which paths in a clone the worker is allowed to change. NULL preserves the
-- pre-existing whole-repository behavior for existing projects.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS fix_surface_globs TEXT[];

-- Archive/unarchive must restore terminal diagnosis conclusions. Added with
-- the diagnosis surface because error groups can now terminate at insight.
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS status_before_archive error_group_status;
