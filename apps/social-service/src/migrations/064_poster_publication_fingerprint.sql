-- Migration 064: record WHICH document a poster published, so the editor can say the live map is
-- older than what has been saved.
--
-- No existing column can answer that question. `publishedAt` cannot: `publish()` writes the row, so
-- TypeORM's @UpdateDateColumn moves `updatedAt` together with it in the same statement, and
-- separating the two would mean deciding staleness by a millisecond of clock - which this repository
-- refuses (see CLAUDE.md, "idempotence comes from durable state"). What is needed is durable state
-- describing the document that actually went live.
--
-- The fingerprint covers the LAYOUT AND THE CONTENT (user, 2026-09-27, D14): the published document
-- embeds the rosters, so a member joining an association genuinely does make the live map stale, and
-- the badge is expected to light up for that too.
--
-- It is computed by the CLIENT, over the document it builds and sends, because the document is built
-- client-side - one implementation decides both sides of the comparison. It is a staleness hint, not
-- an access control, and nothing downstream trusts it for anything else.
--
-- Nullable: a row that is not live has no published document to describe. Idempotent via IF NOT
-- EXISTS.

BEGIN;

ALTER TABLE poster_projects ADD COLUMN IF NOT EXISTS "publicationFingerprint" VARCHAR(64);

COMMIT;
