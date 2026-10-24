-- Migration 016: the outbox of push-registration endings (docs/wiki/sessions.md, "A session that ends
-- takes its device's push registration with it").
--
-- Ending a session ends the push registration that session made on chat-delivery-service. The call
-- used to be fire-and-forget: a chat-delivery that was down at that moment left the registration in
-- place, with no retry. Now every deliberate session delete writes ONE ROW HERE in the SAME
-- transaction as the delete - the logout, an owner revoking a device, "sign out everywhere else" and
-- a refresh-token replay - so a session's end and its push ending are one durable fact: either both
-- are recorded or neither is. `SessionPushEndService` drains it the way `AccountErasureService`
-- drains `account_erasure_jobs`: a claim under `FOR UPDATE SKIP LOCKED` with a lease, one call per
-- row, backoff on failure, and the row deleted once chat-delivery has answered 2xx to its final pass.
--
-- DONE ONLY AFTER A FINAL PASS: an access token minted before the session ended stays valid for up
-- to ACCESS_TOKEN_TTL_SECONDS and can still register with the ended session's id. A 2xx that came
-- before "endedAt" + that TTL (+ skew) keeps the row, due at that instant; the row is deleted only
-- after a pass that started once every such token had expired - the account erasure's final pass.
--
-- ONE ROW PER ENDED SESSION: "sessionId" is the key, because a session ends once. A second writer
-- (a replay racing a logout) adds nothing.
--
-- What a row holds: the ended session's id (`auth_sessions.id`, which no longer exists by then), the
-- account and device ids the call is addressed with, why it ended, and the retry state. No foreign
-- key: the session row is deleted in the transaction that writes this one. The row is deleted once
-- the final pass is done, so nothing is kept longer than an access token can outlive the session.
--
-- Idempotent: the deploy ledger replays a file whose successor failed mid-run.

CREATE TABLE IF NOT EXISTS session_push_endings (
    "sessionId"     UUID PRIMARY KEY,
    "userId"        VARCHAR(255) NOT NULL,
    -- The device the session named, or NULL when it never named one (its registration is still
    -- ended by session).
    "deviceId"      VARCHAR(128),
    -- `logout`, `revoked-by-owner`, `revoked-others` or `replay`: for the log line only.
    cause           VARCHAR(32) NOT NULL,
    -- When the session ended. An access token minted before it can still register for up to
    -- ACCESS_TOKEN_TTL_SECONDS, so the row is kept for one final pass after that instant.
    "endedAt"       TIMESTAMPTZ NOT NULL DEFAULT now(),
    attempts        INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "lastError"     VARCHAR(500)
);

CREATE INDEX IF NOT EXISTS "IDX_session_push_endings_due"
    ON session_push_endings ("nextAttemptAt");
