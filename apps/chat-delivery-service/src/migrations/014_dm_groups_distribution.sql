-- A community's Graine key-distribution group, marked on the group itself.
--
-- One MLS group per community carries SEED material and never a message body (see
-- docs/wiki/protocols/channel-encryption.md 4.3). It lives in dm_groups because it IS an MLS group
-- and every epoch/commit mechanism already there applies to it unchanged - what must not happen is
-- for it to be mistaken for a conversation.
--
-- The column holds the community id rather than a boolean, for two reasons:
--  - the server needs to know WHICH community for every decision it will make about this group, so
--    a boolean would only send it looking the answer up somewhere else;
--  - it makes "exactly one distribution group per community" a fact the DATABASE enforces, through
--    the unique index below, instead of a rule application code has to remember. A second creation
--    then fails loudly rather than producing two groups that each hold half the members.
--
-- No foreign key: workspaces live in social-service's schema, not this one, exactly as channelId
-- references elsewhere in this service do not.
--
-- Idempotent: IF NOT EXISTS throughout, so a re-run and a fresh host behave alike.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'dm_groups') THEN
    ALTER TABLE dm_groups ADD COLUMN IF NOT EXISTS "distributionWorkspaceId" UUID;

    -- Partial: only the distribution groups are constrained, and the millions of ordinary rows
    -- (all NULL) stay out of the index entirely.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dm_groups_distribution_workspace
      ON dm_groups ("distributionWorkspaceId")
      WHERE "distributionWorkspaceId" IS NOT NULL;
  END IF;
END $$;
