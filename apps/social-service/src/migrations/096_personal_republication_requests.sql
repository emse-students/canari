-- Migration 096: an association asks a PERSON to republish their personal post, and only the
-- author's yes makes it visible (D38b, decided by the user on 2026-10-19,
-- docs/wiki/profiles-and-access.md "D38b").
--
-- D38 refused to republish a personal post at all. From here an association's publishers
-- (`POST_AS_ASSO`) may PROPOSE it, and the post's AUTHOR accepts or refuses: a proposal of kind
-- 'repost-personal' on the generic `proposals` table of migration 073, whose acceptor is a USER, not
-- an association. Its acceptance writes the same `post_republications` row an association
-- republication writes, so the reader predicate and the card follow unchanged.
--
-- THE SMALLEST EXTENSION THAT KEEPS THE TABLE HONEST:
-- - `toUserId`, the person asked. A proposal targets EXACTLY ONE of an association or a user
--   (`CHK_proposals_one_target`), and the kind decides which (`CHK_proposals_user_target_kind`):
--   'repost-personal' and only it targets a user, so no association kind can lose its receiver and
--   no user kind can be decided by an association's admins.
-- - `toAssociationId` becomes nullable for that reason. `CHK_proposals_not_to_self` evaluates to
--   NULL on a user-targeted row and therefore passes - correct, there is no association to compare.
-- - Idempotence: 073's unique index is on (kind, subject, toAssociationId), which a NULL target
--   never collides on. A user-targeted proposal is unique per (kind, subject, PROPOSING association)
--   instead - the subject is the post, the post names its one author - so a second ask is a 409, a
--   REFUSAL is recorded and stands, and only a withdrawn row frees the place, as in 073.
-- - The author's inbox reads what is pending FOR a user, hence its partial index.
-- - 073's trigger removed the 'repost' proposals of a deleted post; it now removes both kinds, so a
--   post deleted by any path (its author, a moderator, an account erasure) takes its requests along.
--
-- Old code meeting this schema: it never writes a user-targeted row, and its queue JOINs the target
-- association, so it never shows one. The deploy applies migrations before it replaces the service.
-- Idempotent: the deploy ledger replays a file whose predecessor failed mid-run.

BEGIN;

ALTER TABLE proposals ADD COLUMN IF NOT EXISTS "toUserId" VARCHAR(255) NULL;
ALTER TABLE proposals ALTER COLUMN "toAssociationId" DROP NOT NULL;

ALTER TABLE proposals DROP CONSTRAINT IF EXISTS "CHK_proposals_kind";
ALTER TABLE proposals ADD CONSTRAINT "CHK_proposals_kind"
    CHECK (kind IN ('repost', 'coorganise', 'repost-personal'));

ALTER TABLE proposals DROP CONSTRAINT IF EXISTS "CHK_proposals_one_target";
ALTER TABLE proposals ADD CONSTRAINT "CHK_proposals_one_target"
    CHECK (("toAssociationId" IS NULL) <> ("toUserId" IS NULL));

ALTER TABLE proposals DROP CONSTRAINT IF EXISTS "CHK_proposals_user_target_kind";
ALTER TABLE proposals ADD CONSTRAINT "CHK_proposals_user_target_kind"
    CHECK ((kind = 'repost-personal') = ("toUserId" IS NOT NULL));

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_proposals_subject_from_user_target"
    ON proposals (kind, "subjectId", "fromAssociationId")
    WHERE status <> 'withdrawn' AND "toUserId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "IDX_proposals_user_target_pending"
    ON proposals ("toUserId") WHERE status = 'pending';

CREATE OR REPLACE FUNCTION proposals_drop_deleted_post() RETURNS trigger AS $$
BEGIN
    DELETE FROM proposals WHERE kind IN ('repost', 'repost-personal') AND "subjectId" = OLD.id;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

COMMIT;
