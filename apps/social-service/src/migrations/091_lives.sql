-- Migration 091: lives (WP-L2 and WP-L3 of docs/wiki/frontend/modules/live.md) - the live row, its
-- key, its removed viewers, and the segments its manifest lists.
--
-- See docs/wiki/services/lives.md for the contract and the reasoning behind each column.
--
-- THE END IS DURABLE STATE (Q5): "endedAt" is written once, with its reason, and the CHECK ties the
-- two together. One OPEN live per broadcaster, held by a partial unique index and never by a client
-- check. The segment BYTES live in the media store under `live/<liveId>/<name>`; the rows below are
-- what the manifest lists, and they go with their live (cascade). No replay (L3): the sweep deletes
-- an ended live's segments, then the live row itself.
--
-- A DELETED ACCOUNT (`LIVES_ERASURE_STATEMENTS` in src/internal/account-erasure.ts): its lives are
-- ENDED (reason 'erased') and anonymised, so the sweep deletes them with their segments; a removed-
-- viewer row naming it is deleted.
--
-- User ids are varchar(255): a user id is a 64-char hex digest, never a uuid (`user-id-column.spec.ts`).
-- No foreign key to associations: a live names the association it speaks for only to say so, and an
-- association deleted during a live leaves a live that still ends and is still deleted.
--
-- Additive: three new tables, nothing existing changes. Idempotent for CD: IF NOT EXISTS, or a
-- catalogue check scoped to the current schema. 091: 089 and 090 are the highest on main.

CREATE TABLE IF NOT EXISTS lives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "broadcasterId" varchar(255) NOT NULL,
  "associationId" uuid NULL,
  "liveKey" varchar(64) NOT NULL,
  "startedAt" timestamptz NOT NULL DEFAULT now(),
  "lastSegmentAt" timestamptz NULL,
  "nextIndex" integer NOT NULL DEFAULT 0,
  "endedAt" timestamptz NULL,
  "endReason" varchar(16) NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS lives_one_open_per_broadcaster
  ON lives ("broadcasterId") WHERE "endedAt" IS NULL;
CREATE INDEX IF NOT EXISTS lives_ended_idx ON lives ("endedAt") WHERE "endedAt" IS NOT NULL;

CREATE TABLE IF NOT EXISTS live_segments (
  "liveId" uuid NOT NULL,
  "index" integer NOT NULL,
  name uuid NOT NULL,
  bytes integer NOT NULL,
  sha256 character(64) NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT live_segments_pkey PRIMARY KEY ("liveId", "index")
);

CREATE TABLE IF NOT EXISTS live_removed_viewers (
  "liveId" uuid NOT NULL,
  "viewerId" varchar(255) NOT NULL,
  "removedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT live_removed_viewers_pkey PRIMARY KEY ("liveId", "viewerId")
);

-- Constraints with no IF NOT EXISTS: one guarded block, each looked up in the CURRENT schema only.
DO $$
DECLARE
  ns oid := to_regnamespace(current_schema())::oid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lives_end_pair' AND connamespace = ns) THEN
    ALTER TABLE lives ADD CONSTRAINT lives_end_pair
      CHECK (("endedAt" IS NULL) = ("endReason" IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lives_end_reason' AND connamespace = ns) THEN
    ALTER TABLE lives ADD CONSTRAINT lives_end_reason
      CHECK ("endReason" IS NULL OR "endReason" IN ('broadcaster', 'dropped', 'max_duration', 'erased'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lives_next_index' AND connamespace = ns) THEN
    ALTER TABLE lives ADD CONSTRAINT lives_next_index CHECK ("nextIndex" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'live_segments_index' AND connamespace = ns) THEN
    ALTER TABLE live_segments ADD CONSTRAINT live_segments_index CHECK ("index" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'live_segments_bytes' AND connamespace = ns) THEN
    ALTER TABLE live_segments ADD CONSTRAINT live_segments_bytes CHECK (bytes > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'live_segments_live_fk' AND connamespace = ns) THEN
    ALTER TABLE live_segments ADD CONSTRAINT live_segments_live_fk
      FOREIGN KEY ("liveId") REFERENCES lives (id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'live_removed_viewers_live_fk' AND connamespace = ns) THEN
    ALTER TABLE live_removed_viewers ADD CONSTRAINT live_removed_viewers_live_fk
      FOREIGN KEY ("liveId") REFERENCES lives (id) ON DELETE CASCADE;
  END IF;
END
$$;
