-- Migration 003 : give the refresh token a row, so a session can be revoked.
--
-- Before this table the refresh token was a stateless 7-day bearer credential:
-- `logout` cleared the cookie and revoked nothing, a stolen cookie minted a
-- fresh 7 days on every use in parallel with the real user, and the only lever
-- that existed was rotating JWT_SECRET - which signs every user out of all six
-- services at once.
--
-- The access token stays stateless on purpose (six services and the nginx
-- auth_request verify it with no database round trip), so this row backs the
-- REFRESH token only. `tokenId` is the single `jti` the session accepts;
-- `previousTokenId` + `rotatedAt` keep the token it replaced usable for a short
-- grace window, without which two browser tabs refreshing at once would be
-- indistinguishable from a stolen cookie.
--
-- Idempotent: CREATE TABLE / INDEX IF NOT EXISTS (TypeORM synchronize creates
-- them in dev; this covers production where synchronize is disabled).

CREATE TABLE IF NOT EXISTS auth_sessions (
    id                UUID PRIMARY KEY,
    "userId"          VARCHAR(255) NOT NULL,
    "tokenId"         UUID NOT NULL,
    "previousTokenId" UUID,
    "rotatedAt"       TIMESTAMPTZ,
    "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT now(),
    "lastUsedAt"      TIMESTAMPTZ NOT NULL DEFAULT now(),
    "expiresAt"       TIMESTAMPTZ NOT NULL,
    "userAgent"       VARCHAR(255),
    "lastIp"          VARCHAR(45)
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions ("userId");
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions ("expiresAt");

-- Deleting an account must not leave live sessions behind. Added separately
-- because ADD CONSTRAINT has no IF NOT EXISTS.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_auth_sessions_user'
    ) THEN
        ALTER TABLE auth_sessions
            ADD CONSTRAINT fk_auth_sessions_user
            FOREIGN KEY ("userId") REFERENCES users (id) ON DELETE CASCADE;
    END IF;
END
$$;
