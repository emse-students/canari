-- Migration 155 : the follow suggestions a reader dismissed (engagement WP-5, decision 2).
--
-- docs/wiki/engagement.md, "The dismissal store". The owner (2026-11-07): a suggestion card carries
-- an X, and an account the reader dismissed is never suggested to them again - like an account they
-- already follow, a pending request, a block, or themself.
--
-- ONE ROW PER (reader, kind, target), the primary key: dismissing twice writes nothing new.
--
-- - `userId`: the reader who pressed the X.
-- - `targetKind`: 'user' (a person) or 'association' (an association, a list or an institution).
-- - `targetId`: a user id, or an association uuid as text. No foreign key: `users` is core-service's
--   table and one column serves both kinds. The account erasure deletes the rows where the erased
--   account is `userId` OR the target (`account-erasure.ts`); a row naming a deleted association is
--   inert (a deleted association is never suggested) and is taken by its dismisser's erasure.
--
-- A DISMISSAL IS PERMANENT (Instagram's): no clock brings the account back, and following then
-- unfollowing does not clear it. A dismissed account is still found by search.
--
-- READ by the suggestion query (`follows/suggestions.service.ts`) through the primary key; the
-- target index serves the erasure's `OR "targetId" = $1`.
--
-- ADDITIVE: a new table and an index, no existing row read or changed. Idempotent for CD: IF NOT
-- EXISTS. LOCKS: none on an existing table; the migration gives up after 5 s rather than queue.

SET lock_timeout = '5s';

BEGIN;

CREATE TABLE IF NOT EXISTS follow_suggestion_dismissals (
  "userId" varchar(255) NOT NULL,
  "targetKind" varchar(16) NOT NULL CHECK ("targetKind" IN ('user', 'association')),
  "targetId" varchar(255) NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("userId", "targetKind", "targetId")
);

CREATE INDEX IF NOT EXISTS "IDX_follow_suggestion_dismissals_target"
  ON follow_suggestion_dismissals ("targetKind", "targetId");

COMMIT;
