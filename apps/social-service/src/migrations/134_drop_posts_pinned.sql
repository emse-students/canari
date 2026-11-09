-- canari:hold-for-owner - a DROP COLUMN: `posts.pinned`, the retired global pin (WP-PIN).
--
-- Migration 134: the global pin column goes (docs/wiki/legacy-compatibility.md, the `posts.pinned`
-- row; docs/wiki/spaces-and-audiences-reform.md section 11).
--
-- WHY IT IS DEAD. Since WP-PIN (#2984, migration 127) a pin is a row of `post_space_pins` per space,
-- and nothing reads or writes `posts.pinned`: the served `pinned` field is computed per reader from
-- `post_space_pins` (`pinnedForViewerSql`), an older client's body-less pin goes through
-- `SpacePinsService`, and the validation pipe's whitelist strips any `pinned` a client might send.
-- The column was kept only for migration 128 to read, and 128 has run on BOTH estates: dev through
-- `v1.6.3-alpha.6`, production through `v1.6.3` (2026-11-03, a backup taken right before it), where
-- the one flagged post was carried into a space pin (`INSERT 0 1`, no pin left uncarried).
--
-- NOT IN THE RELEASE THAT UNMAPPED IT. The deploy applies migrations before the rolling replacement,
-- and an image that still maps `pinned` names it in every `INSERT INTO posts` (TypeORM lists every
-- mapped column, `DEFAULT` for an unset one). So this file ships only once `prod-released` contains
-- the commit that removed the entity property (docs/wiki/durable-rules.md, Release and CI), and DEV
-- too: no pre-release carries it while dev runs an image without that commit. Once it has run, a
-- rollback to ANY image older than that commit fails every post INSERT: the oldest image a rollback
-- may reach is the first release containing it (docs/wiki/legacy-compatibility.md, `posts.pinned`).
--
-- Held for the owner's hand-merge (`-- canari:hold-for-owner`, docs/wiki/cicd.md): a DROP, which the
-- judge holds anyway. The deploy takes a backup right before it; the dropped values are one boolean
-- per post, all of whose meaning 128 already moved.
--
-- Idempotent for CD: `DROP COLUMN IF EXISTS`, so a replay, or a local stack whose `synchronize`
-- already dropped the column with the entity property, does nothing. No CASCADE: no index, view or
-- constraint names the column, and one that did should stop this file loudly rather than go with it.
-- LOCKS: ACCESS EXCLUSIVE on `posts` for a catalogue change alone (a dropped column is only marked
-- dropped - no scan, no rewrite), released at COMMIT. A request holding a lock on `posts` makes the
-- migration give up after 5 s rather than queue every feed read behind it (the re-run is safe).

SET lock_timeout = '5s';

BEGIN;

ALTER TABLE posts DROP COLUMN IF EXISTS pinned;

COMMIT;
