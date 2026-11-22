-- Migration 054: what the push chain did, kept past a deploy (owner, 2026-11-21: "totals + last
-- delivery"; docs/wiki/services/chat-delivery.md, "Push delivery records").
--
-- `push_delivery_daily`: per UTC day, send path (`kind`: message, social, ring, ring_end,
-- welcome_request), platform and outcome (attempted, accepted, failed, pruned), a COUNT; a failure is
-- broken down by the provider's code (`code`, '' for every other outcome). Incremented once per send
-- batch by an upsert (`utils/push-delivery-records.ts`). No account, no device, no content: it is
-- not personal data, and has no retention to enforce (a few dozen rows a day).
--
-- `push_token."lastPushSentAt"`: the last time a provider ACCEPTED a push for this registration.
-- `push_token."lastPushFetchedAt"`: the last time its native handler fetched what a push pointed at
-- (`GET /mls/push/fetch-proto`, `GET /mls/push/wake`). Two dates, nothing else; they live on the
-- registration row, so every deletion of it - session end, revocation, invalid-token prune, account
-- erasure - takes them. The registration's upsert names its columns, so a re-registration keeps them.
--
-- ADDITIVE ONLY: a new table, two nullable columns with no default and no backfill. A release that
-- predates it reads none of them, so a rollback is safe.
--
-- LOCK TIMEOUT: ADD COLUMN takes ACCESS EXCLUSIVE on `push_token`, which every send reads. The
-- migration gives up after five seconds rather than queue behind a long transaction; the deploy then
-- fails loudly and a re-run is safe (idempotent). A nullable column is a catalogue-only change.
SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "push_delivery_daily" (
    "day"      date NOT NULL,
    "kind"     varchar(16) NOT NULL,
    "platform" varchar(16) NOT NULL,
    "outcome"  varchar(16) NOT NULL,
    "code"     varchar(96) NOT NULL DEFAULT '',
    "count"    bigint NOT NULL DEFAULT 0,
    CONSTRAINT "PK_push_delivery_daily" PRIMARY KEY ("day", "kind", "platform", "outcome", "code")
);

ALTER TABLE "push_token" ADD COLUMN IF NOT EXISTS "lastPushSentAt" timestamptz;
ALTER TABLE "push_token" ADD COLUMN IF NOT EXISTS "lastPushFetchedAt" timestamptz;
