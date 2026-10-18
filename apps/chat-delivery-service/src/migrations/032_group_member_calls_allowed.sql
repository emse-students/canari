-- Migration 032: whether ONE private conversation may ring ONE member - its own setting, beside the
-- notification level of migration 029 (user, 2026-10-18: "a 4th profile to allow or not calls").
--
-- Stored like the level, on the member's own membership row: per ACCOUNT, every device, survives a
-- reinstall, ends with the membership (leaving and account erasure hard-delete the row).
--
-- NULL IS "NEVER CHOSEN", AND IT IS THE ONLY VALUE AN OLDER CLIENT EVER LEAVES. A member who never
-- chose takes the default `callsAllowedFor` computes: calls ring unless the conversation's level is
-- `none` - a conversation muted to `none` does not ring, which is what such a member was already
-- getting (the invite frame is sent silent there). An explicit true/false overrides the level either
-- way. The rule and why it is the least surprising one: docs/wiki/frontend/modules/calls.md.
--
-- Additive, no data rewrite: every existing row reads NULL. Idempotent: ADD COLUMN IF NOT EXISTS.

ALTER TABLE dm_group_members
    ADD COLUMN IF NOT EXISTS "callsAllowed" BOOLEAN NULL;
