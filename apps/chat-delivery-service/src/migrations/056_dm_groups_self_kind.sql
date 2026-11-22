-- Migration 056: dm_groups."kind", and the one live "Mes notes" conversation per account (2026-11-22).
--
-- "Mes notes" is a conversation with oneself (owner, 2026-11-22; principles 1 and 2): an MLS group
-- whose only member is its creator's account, end-to-end encrypted between that account's own
-- devices exactly like any other conversation. It lives in dm_groups because it IS an MLS group and
-- every epoch, commit, history and media mechanism already there applies to it unchanged. What
-- must not happen is for it to be mistaken for a 1:1 with a peer (a client would hunt for a peer
-- that does not exist) or to gain a second person. So the row SAYS what it is:
--
--   "kind" = 'conversation' - every existing row, and every group or 1:1 created from now on;
--   "kind" = 'self'         - the account's own notes, created by `POST mls/groups` with
--                              `kind: 'self'`, flagged `isGroup = false`, named nobody.
--
-- A column rather than a boolean so the next kind is a value, not a second column; a CHECK names the
-- values the service writes, so a typo is refused by the database rather than read as an ordinary
-- conversation.
--
-- ONE LIVE NOTES CONVERSATION PER ACCOUNT, said by the DATABASE: a unique partial index on the
-- creator ("createdBy", the authenticated caller of the creation, canonical form) over live self
-- rows. Two devices creating at the same instant: the route inserts with `ON CONFLICT DO NOTHING`, so
-- the second insert writes nothing and the route answers 409 `SELF_CONVERSATION_EXISTS` with the live
-- row's id and whether another device holds it - durable state decides, never a clock.
-- A tombstone ("deletedAt" set - a deletion, or the account's erasure, which tombstones a one-person
-- roster and then rewrites "createdBy" to `[deleted]`) leaves the index, so a deleted notes
-- conversation can be created again and two erased accounts never collide on `[deleted]`.
-- Mechanism: docs/wiki/services/chat-delivery.md ("Mes notes - the self conversation").
--
-- Additive: ADD COLUMN with a constant DEFAULT is a catalogue change on PostgreSQL >= 11 and rewrites
-- no row; every existing row reads 'conversation'. The CHECK is added NOT VALID, then VALIDATEd (a
-- scan under SHARE UPDATE EXCLUSIVE, which blocks no reader or writer). The index covers no existing
-- row (none is 'self'). Nothing is deleted.
-- Reversible: a release that predates it never reads the columns; `DROP INDEX
-- idx_dm_groups_one_live_self_per_account; ALTER TABLE dm_groups DROP CONSTRAINT
-- chk_dm_groups_kind, DROP COLUMN "kind"; ALTER TABLE key_package DROP COLUMN
-- "selfConversationVersion"` undoes it. A release that predates it would then serve a self row as an
-- ordinary 1:1 and seat every device of the account in it - so a rollback past 056 is only safe while
-- no self row exists.
--
-- WHICH DEVICE MAY HOLD IT: `key_package."selfConversationVersion"`, what the device's build states on
-- every `register-device` (0 when it states nothing). A build that does not know the self kind reads a
-- self group it is Welcomed into as an ordinary group it may rename, invite into and DELETE - a delete
-- that tombstones the notes on every device. So no seat, no Admit, no Welcome and no welcome request
-- for a self group is accepted for a device below version 1, and a deletion of a self group is
-- refused unless the request says it knows the kind (legacy-compatibility.md, "Mes notes").
-- Written as stated on every registration, so an old build reinstalled on the same device id is
-- version 0 again.
-- Idempotent: IF NOT EXISTS throughout, the constraint guarded by name (synchronize creates the
-- column in dev; this is for prod).
--
-- LOCK TIMEOUT: ADD COLUMN takes ACCESS EXCLUSIVE on `dm_groups` and `key_package`, which the commit
-- gate, the send path and every registration read, and the index build takes SHARE. None rewrites a
-- table, but the lock request would still queue behind a long transaction and stall every reader
-- behind it, so the migration gives up after five seconds instead; the deploy then fails loudly and a re-run is safe. Asserted by
-- `migrations.lock-timeout.spec.ts`.
SET lock_timeout = '5s';

ALTER TABLE "dm_groups"
    ADD COLUMN IF NOT EXISTS "kind" VARCHAR(16) NOT NULL DEFAULT 'conversation';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_dm_groups_kind') THEN
    ALTER TABLE "dm_groups"
      ADD CONSTRAINT chk_dm_groups_kind
      CHECK (
        "kind" IN ('conversation', 'self')
        -- A notes conversation is one person's, never a group chat and never a seed carrier.
        AND (
          "kind" <> 'self'
          OR ("isGroup" = false
              AND "distributionWorkspaceId" IS NULL
              AND "distributionChannelId" IS NULL)
        )
      ) NOT VALID;
  END IF;
END $$;

ALTER TABLE "dm_groups" VALIDATE CONSTRAINT chk_dm_groups_kind;

ALTER TABLE "key_package"
    ADD COLUMN IF NOT EXISTS "selfConversationVersion" SMALLINT NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_dm_groups_one_live_self_per_account
    ON "dm_groups" ("createdBy")
    WHERE "kind" = 'self' AND "deletedAt" IS NULL;
