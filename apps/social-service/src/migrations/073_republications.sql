-- Migration 073: republication (D38) and the proposals that ask for it, decided by the user on
-- 2026-10-04 (docs/wiki/profiles-and-access.md, "Republication").
--
-- A POST REACHES THE AUDIENCE OF ITS ASSOCIATION PLUS THE AUDIENCE OF EACH ASSOCIATION THAT
-- REPUBLISHES IT, like a LinkedIn repost. `post_republications` is that list: one row per (post,
-- association), so the same pair cannot be republished twice. The reader predicate
-- (`spaces/reader-spaces.ts` `postVisibleToUserSql`) reads it; a deleted post or association takes
-- its rows with it, and hiding a post deletes them in the service (a hide is not a row deletion).
--
-- A PROPOSAL IS THE OTHER ASSOCIATION'S CONSENT, and the table is GENERIC on purpose: `kind`
-- 'repost' is the first, event co-organisation ('coorganise', D39) is the next and will widen the
-- CHECK below. `subjectId` names the post (or, later, the event) and carries no foreign key because
-- it names different tables per kind - the trigger at the end removes a repost proposal whose post
-- is deleted, by whatever path (a user, a moderator, the reel purge, an account deletion). The same
-- (kind, subject, target) cannot be pending or decided twice: a refusal is recorded and stands, and
-- only a WITHDRAWN proposal makes room for a new one. No expiry - no clock decides a proposal.
--
-- AND THE PER-POST SPACE RULES OF WP6b GO (D38): what widens a post is a republication, never its
-- author, so `post_audiences` (migration 071) is dropped with nothing reading it.
--
-- Idempotent: the deploy ledger replays a file whose predecessor failed mid-run.

DROP TABLE IF EXISTS post_audiences;

CREATE TABLE IF NOT EXISTS post_republications (
    "postId"          UUID NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
    "associationId"   UUID NOT NULL REFERENCES associations (id) ON DELETE CASCADE,
    "republishedBy"   VARCHAR(255) NOT NULL,
    "republishedAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "PK_post_republications" PRIMARY KEY ("postId", "associationId")
);
-- The reader predicate joins on the post; "what did this association republish" on the other side.
CREATE INDEX IF NOT EXISTS "IDX_post_republications_association"
    ON post_republications ("associationId");

CREATE TABLE IF NOT EXISTS proposals (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind                VARCHAR(32) NOT NULL,
    "subjectId"         UUID NOT NULL,
    "fromAssociationId" UUID NOT NULL REFERENCES associations (id) ON DELETE CASCADE,
    "toAssociationId"   UUID NOT NULL REFERENCES associations (id) ON DELETE CASCADE,
    status              VARCHAR(16) NOT NULL DEFAULT 'pending',
    "proposedBy"        VARCHAR(255) NOT NULL,
    "decidedBy"         VARCHAR(255) NULL,
    "createdAt"         TIMESTAMPTZ NOT NULL DEFAULT now(),
    "decidedAt"         TIMESTAMPTZ NULL,
    CONSTRAINT "CHK_proposals_kind" CHECK (kind IN ('repost')),
    CONSTRAINT "CHK_proposals_status"
        CHECK (status IN ('pending', 'accepted', 'refused', 'withdrawn')),
    CONSTRAINT "CHK_proposals_not_to_self" CHECK ("fromAssociationId" <> "toAssociationId"),
    -- A decision is a status, an actor and an instant, together or not at all.
    CONSTRAINT "CHK_proposals_decided"
        CHECK ((status = 'pending') = ("decidedAt" IS NULL AND "decidedBy" IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS "UQ_proposals_subject_target"
    ON proposals (kind, "subjectId", "toAssociationId") WHERE status <> 'withdrawn';
-- The management page's queue: what is pending FOR an association.
CREATE INDEX IF NOT EXISTS "IDX_proposals_target_pending"
    ON proposals ("toAssociationId") WHERE status = 'pending';

CREATE OR REPLACE FUNCTION proposals_drop_deleted_post() RETURNS trigger AS $$
BEGIN
    DELETE FROM proposals WHERE kind = 'repost' AND "subjectId" = OLD.id;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "TRG_posts_drop_repost_proposals" ON posts;
CREATE TRIGGER "TRG_posts_drop_repost_proposals"
    AFTER DELETE ON posts
    FOR EACH ROW EXECUTE FUNCTION proposals_drop_deleted_post();
