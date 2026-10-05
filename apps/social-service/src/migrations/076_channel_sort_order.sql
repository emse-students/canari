-- Migration 076: a community's salons have a position, shared by every member.
--
-- Until now the sidebar listed a community's salons in whatever order the database returned them.
-- `channels."sortOrder"` is that order, written by `PATCH workspaces/:id/channels/reorder` (drag and
-- drop, for whoever may manage salons). Ties break on "createdAt" in the service, so the column
-- alone never has to be unique.
--
-- BACKFILL: each community that has never been arranged (every salon still at 0) is numbered by
-- creation date, which is the order the sidebar has shown in practice, so nothing visibly moves.
-- A community already holding a non-zero position is left alone, which is also what makes a
-- replay (the deploy ledger re-runs a file whose predecessor failed mid-run) a no-op.

ALTER TABLE channels ADD COLUMN IF NOT EXISTS "sortOrder" integer NOT NULL DEFAULT 0;

UPDATE channels c
   SET "sortOrder" = ranked.pos
  FROM (
        SELECT id,
               (ROW_NUMBER() OVER (PARTITION BY "workspaceId" ORDER BY "createdAt", id) - 1) AS pos
          FROM channels
       ) ranked
 WHERE c.id = ranked.id
   AND c."workspaceId" IN (
        SELECT "workspaceId" FROM channels GROUP BY "workspaceId" HAVING MAX("sortOrder") = 0
   );
