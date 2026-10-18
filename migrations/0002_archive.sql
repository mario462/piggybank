-- Reference only. The API adds this column automatically on first use.
-- When a category was archived (a finished goal); NULL while it is active.
ALTER TABLE categories ADD COLUMN archived_at INTEGER;
