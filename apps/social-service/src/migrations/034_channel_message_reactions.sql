-- Adds the `reactions` tally to channel messages (emoji -> array of user ids).
-- The column has been declared on the entity for a long time but was never used, so a database
-- created with synchronize=true already has it while production (synchronize=false) may not.
-- IF NOT EXISTS makes this a no-op on the former.

ALTER TABLE channel_messages
  ADD COLUMN IF NOT EXISTS reactions jsonb NOT NULL DEFAULT '{}'::jsonb;
