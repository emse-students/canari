-- Migration 079 : a per-association MUTE of push notifications.
--
-- One row = one account that no longer wants the PUSH of ONE association. It silences nothing else:
-- the post stays in the feed, the in-app notification row is still written, and an association's
-- managers keep the operational pushes (proposals to approve, agenda decisions). Following is a
-- separate fact (`association_follows`) and is NOT consulted for announcing; see
-- docs/wiki/notifications.md, "Follow, mute and read grants".
--
-- Idempotent for CD: IF NOT EXISTS everywhere.

CREATE TABLE IF NOT EXISTS association_push_mutes (
  "userId" varchar(255) NOT NULL,
  "associationId" uuid NOT NULL REFERENCES associations (id) ON DELETE CASCADE,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("userId", "associationId")
);
