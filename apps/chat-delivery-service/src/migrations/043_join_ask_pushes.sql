-- Migration 043: dm_join_ask_pushes, the one-push-per-ask claim (2026-11-01).
--
-- An invitation-link ask (a seat written awaiting a member's admission) sends ONE ordinary push to
-- the members already admitted ("X veut rejoindre ..."). The claim is keyed by (groupId, userId),
-- NOT by the seat row: a seat dies with the joiner's own withdrawal and a re-follow of the link
-- writes a new one, so a claim on the seat was re-armed by the joiner alone and pushed every member
-- again with no member acting. `gen` is the person's dm_seat_evictions."declinedAtSeatGeneration"
-- (0 when none) - a counter only a MEMBER's Decline moves - and a claim succeeds only for a strictly
-- larger one: one push per Decline, none for a withdrawal or an expiry. Durable state, never a timer.
-- Mechanism: docs/wiki/protocols/mls-protocol.md ("One push per ask").
--
-- Additive: a new table, no existing row touched, nothing deleted. A person with an ask already on
-- screen when this ships has no row, so their NEXT acceptance pushes once, then never again until a
-- member declines them.
-- Idempotent: CREATE TABLE IF NOT EXISTS (synchronize creates it in dev; this is for prod).
--
-- LOCK TIMEOUT: creating a table locks no existing one, but the migration still gives up after five
-- seconds rather than queue behind a long transaction on the catalogue; the deploy then fails loudly
-- and a re-run is safe. Asserted by `migrations.lock-timeout.spec.ts`.
SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "dm_join_ask_pushes" (
    "groupId" UUID NOT NULL,
    "userId"  VARCHAR(255) NOT NULL,
    "gen"     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY ("groupId", "userId")
);
