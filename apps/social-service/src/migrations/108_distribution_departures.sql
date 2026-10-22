-- Migration 108: distribution_departures, how each departure from a key-distribution group ended.
--
-- See apps/social-service/src/channels/entities/distribution-departure.entity.ts and
-- docs/wiki/protocols/channel-encryption.md ("WP-21, and the gate it had nowhere to live").
--
-- chat-delivery names a departure when it begins it. The roster write records it `departed` in its
-- own transaction; chat-delivery's drain, asking about one whose second eviction never arrived,
-- records it `cancelled` if nothing is there yet. The primary key makes the first writer win, so
-- the answer the drain reads is final.
--
-- Schema only: a new empty table. No row is changed, nothing is backfilled, nothing is dropped.
--
-- Idempotent for CD: IF NOT EXISTS.
--
-- LOCK TIMEOUT: the same rule as chat-delivery's 035 - a migration gives up rather than queue
-- behind a long transaction and stall everything queued behind its lock request; the deploy then
-- fails loudly and a re-run is safe (idempotent above).
SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS distribution_departures (
  "groupId"   uuid NOT NULL,
  "userId"    varchar(255) NOT NULL,
  "departure" integer NOT NULL,
  "outcome"   varchar(16) NOT NULL CHECK ("outcome" IN ('departed', 'cancelled')),
  "createdAt" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("groupId", "userId", "departure")
);
