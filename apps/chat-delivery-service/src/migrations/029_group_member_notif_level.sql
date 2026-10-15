-- Migration 029: how loud ONE private conversation is, for ONE member - all / mentions / none.
--
-- The same three levels a community salon has (`channel_members.notifLevels`, social-service), stored
-- the same way: on the member's own membership row, so it is per ACCOUNT (it follows the member to
-- every device and survives a reinstall) and it ends with the membership (leaving hard-deletes the
-- row). Read by MessagingService before every visible push of the conversation; the design, and why
-- `mentions` is decided by the DEVICE, is in docs/wiki/services/chat-delivery.md.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, and the CHECK is added only when absent. Every existing row
-- takes the default `all`, which is what every conversation did before this column.

ALTER TABLE dm_group_members
    ADD COLUMN IF NOT EXISTS "notifLevel" VARCHAR(16) NOT NULL DEFAULT 'all';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'dm_group_members_notif_level_check'
    ) THEN
        ALTER TABLE dm_group_members
            ADD CONSTRAINT dm_group_members_notif_level_check
            CHECK ("notifLevel" IN ('all', 'mentions', 'none'));
    END IF;
END $$;
