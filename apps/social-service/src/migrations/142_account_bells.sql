-- Migration 142 : the per-account bell - what a reader receives from ONE account (engagement WP-3).
--
-- docs/wiki/engagement.md, "The bell - data model". Decisions 3d, 5a and 10 of the owner
-- (2026-11-07): a bell on a person's profile and on an association's page chooses what its pushes
-- the reader receives - posts and lives (the default, set by following), lives only, or nothing.
--
-- THREE LEVELS, TWO STORED (L3). No row = "posts and lives", the state every account already has, so
-- the table needs no backfill for the default and a stored `all` would be a second spelling of it.
-- `lives` and `none` are the two reductions. A follow that COMES INTO BEING deletes the reader's row
-- for that account in the statement that creates it (`FollowsService.followAssociation`,
-- `FollowRequestsService.accept`), so following again is a fresh "posts and lives".
--
-- `targetId` is a user id (`targetKind = 'user'`) or an association uuid as text
-- (`'association'`): no foreign key, since `users` is core-service's table and one column serves
-- both kinds. The reader's account erasure deletes the rows where it is `userId` OR the `user`
-- target (`account-erasure.ts`); a row naming a deleted association is inert (nothing pushes as it)
-- and is deleted by that association's own deletion (`AssociationsService.remove`).
--
-- READ by the one place that pushes (`PostNotificationsService.fanOutPush`), as "which of this
-- push's recipients reduced THIS account" - ("targetKind", "targetId", "userId"), hence the second
-- index. The reader's own lookups use the primary key.
--
-- The copy of `association_push_mutes` into this table is a BACKFILL, so it is migration 143, HELD
-- for the owner's approval (L8, "Which migrations are held").
--
-- ADDITIVE: a new table and an index, no existing row read or changed. Idempotent for CD: IF NOT
-- EXISTS. LOCKS: none on an existing table; the migration gives up after 5 s rather than queue.

SET lock_timeout = '5s';

BEGIN;

CREATE TABLE IF NOT EXISTS account_bells (
  "userId" varchar(255) NOT NULL,
  "targetKind" varchar(16) NOT NULL CHECK ("targetKind" IN ('user', 'association')),
  "targetId" varchar(255) NOT NULL,
  level varchar(8) NOT NULL CHECK (level IN ('lives', 'none')),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("userId", "targetKind", "targetId")
);

-- One push asks "which of these recipients reduced THIS account": the target first.
CREATE INDEX IF NOT EXISTS "IDX_account_bells_target"
  ON account_bells ("targetKind", "targetId", "userId");

COMMIT;
