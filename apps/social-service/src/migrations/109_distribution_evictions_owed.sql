-- Migration 109: the key-distribution evictions a removal OWES, recorded in its transaction.
--
-- A removal from a community or a private salon (a kick, a salon removal, an access-list update)
-- runs its permission check, its roster change and this record in ONE transaction under the
-- community's removal lock, and calls chat-delivery to evict the user from the distribution group
-- only AFTER the commit, from these rows (`ChannelService.settleOwedEvictions`). A row is deleted
-- once its call succeeded; a failed call leaves it, and every later pass (after each removal, at
-- boot, every minute) retries it. See docs/wiki/services/social-service.md.
--
-- One row per (kind, scope, user): owed again while still owed, the row takes a new `token`, so a
-- pass that read the previous one cannot delete it.
--
-- Schema only: a new table. It may ride the same release as the code that writes it: the deploy
-- applies the migrations BEFORE it replaces any application service.
--
-- Idempotent for CD: IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS distribution_evictions_owed (
  kind VARCHAR(16) NOT NULL CHECK (kind IN ('workspace', 'channel')),
  "scopeId" UUID NOT NULL,
  "userId" VARCHAR(255) NOT NULL,
  reason VARCHAR(64) NOT NULL,
  token UUID NOT NULL DEFAULT gen_random_uuid(),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, "scopeId", "userId")
);
