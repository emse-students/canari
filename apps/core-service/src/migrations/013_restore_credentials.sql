-- Migration 013: the restore keys of Android's Restore Credentials API (WP-RESTORE-1), and the
-- single-use record of their challenges. Design and threat model: docs/wiki/account-restore.md.
--
-- A restore key is worth NO MORE THAN THE SESSION THAT REGISTERED IT, and that is enforced here
-- rather than by a sweep of its own: "sessionId" cascades from auth_sessions, so every way a session
-- ends - sign-out, "remove this device", "sign out everywhere else", the one-session-per-device
-- purge, the 7-day idle sweep, account erasure - ends its key. UNIQUE("sessionId"): one key per
-- session, a re-registration replaces it. A restore CONSUMES its key (the row is deleted when the
-- assertion verifies) and then revokes the session it was bound to: a restore is a transfer.
--
-- The server holds the PUBLIC key only. "cloudBackup" is what the phone did (true: Google backup;
-- false: the E2eeUnavailable second path), kept so the rate of that second path is one GROUP BY.
--
-- "userId" duplicates the session's on purpose: it is the account-id column the erasure deletes by
-- name (CORE_ERASURE_STATEMENTS), so the erasure does not depend on a cascade it cannot see.
--
-- restore_challenges_spent holds no account id: a nonce, written only once an assertion's signature
-- has verified, and its expiry for the sweep.
--
-- Idempotent: the deploy ledger replays a file whose predecessor failed mid-run.

CREATE TABLE IF NOT EXISTS restore_credentials (
    id             TEXT PRIMARY KEY,
    "userId"       VARCHAR(255) NOT NULL,
    "sessionId"    UUID NOT NULL,
    "publicKey"    BYTEA NOT NULL,
    counter        BIGINT NOT NULL DEFAULT 0,
    "cloudBackup"  BOOLEAN NOT NULL,
    "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_restore_credentials_session ON restore_credentials ("sessionId");
CREATE INDEX IF NOT EXISTS idx_restore_credentials_user ON restore_credentials ("userId");

-- Constraints have no IF NOT EXISTS, so they are added in a block, each looked up in the CURRENT
-- schema only (as social-service 087 does): a same-named constraint in another schema must never
-- make this file skip its own.
DO $$
DECLARE
    ns oid := to_regnamespace(current_schema())::oid;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'fk_restore_credentials_session' AND connamespace = ns
    ) THEN
        ALTER TABLE restore_credentials
            ADD CONSTRAINT fk_restore_credentials_session
            FOREIGN KEY ("sessionId") REFERENCES auth_sessions (id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'fk_restore_credentials_user' AND connamespace = ns
    ) THEN
        ALTER TABLE restore_credentials
            ADD CONSTRAINT fk_restore_credentials_user
            FOREIGN KEY ("userId") REFERENCES users (id) ON DELETE CASCADE;
    END IF;
END
$$;

CREATE TABLE IF NOT EXISTS restore_challenges_spent (
    nonce          TEXT PRIMARY KEY,
    "expiresAt"    TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_restore_challenges_spent_expires
    ON restore_challenges_spent ("expiresAt");
