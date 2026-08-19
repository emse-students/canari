-- A distribution group can now be scoped to a PRIVATE SALON, not only to a community.
--
-- WHY. Graine gives a community exactly one distribution group, so a private salon's seed is sealed
-- to every member of the community. Since 2026-08-19 the server no longer hands those members the
-- ciphertext (channel-encryption.md §11), but that is server enforcement, not cryptography: nothing
-- stops them reading it if they obtain it another way. A group per private salon, whose roster is
-- the salon's own audience, is the structural answer.
--
-- ONE COLUMN, NOT A SECOND TABLE. The two scopes are the same object with a different roster, and
-- the code path that creates, reads, publishes to, evicts from and tombstones them is one path.
-- Splitting them would double a surface that has already been audited once.
--
-- EXACTLY ONE OF THE TWO IS SET. The check is written rather than assumed, because a row with both
-- would be reachable from two scopes and served to two different rosters - which is the precise
-- shape of the defect this whole change exists to remove.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'dm_groups') THEN
    ALTER TABLE dm_groups ADD COLUMN IF NOT EXISTS "distributionChannelId" UUID;

    -- Same shape as the community index (014): partial, so the overwhelming majority of rows -
    -- ordinary conversations, both columns null - cost nothing and are not made unique against
    -- each other.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dm_groups_distribution_channel
      ON dm_groups ("distributionChannelId")
      WHERE "distributionChannelId" IS NOT NULL;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'dm_groups_one_distribution_scope'
    ) THEN
      ALTER TABLE dm_groups ADD CONSTRAINT dm_groups_one_distribution_scope
        CHECK ("distributionWorkspaceId" IS NULL OR "distributionChannelId" IS NULL);
    END IF;
  END IF;
END $$;
