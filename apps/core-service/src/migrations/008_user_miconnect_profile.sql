-- Migration 008: the MiConnect profile, held on the account.
--
-- WP3 of the profile reform (docs/wiki/profiles-and-access.md). MiConnect (authentik) is the source
-- of truth for who a person IS: a campus, zero or more cursus entries ({formation, promo}) and zero
-- or more posts (EMSE, ME, ALUMNI). Canari never re-reads authentik after the first sign-in except
-- through the OIDC callback, so the callback REPLACES these four columns wholesale at every sign-in
-- (a claim that vanished clears the column), and a one-shot backfill reaches the accounts that will
-- never sign in again.
--
-- `promo` and `formation` stay, derived from the FIRST cursus entry, until every consumer reads
-- `cursus` (WP6). `miconnectUuid` is authentik's own user uuid (claim `miconnect_uuid`): `users.id`
-- is the hashed subject and cannot address the authentik user, which WP4's edits must.
--
-- Idempotent: the deploy ledger replays a file whose predecessor failed mid-run.

ALTER TABLE users ADD COLUMN IF NOT EXISTS "miconnectUuid" VARCHAR(36);
ALTER TABLE users ADD COLUMN IF NOT EXISTS campus VARCHAR(32);
ALTER TABLE users ADD COLUMN IF NOT EXISTS cursus JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS posts TEXT[] NOT NULL DEFAULT '{}';

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_users_miconnectUuid"
    ON users ("miconnectUuid") WHERE "miconnectUuid" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "IDX_users_campus" ON users (campus) WHERE campus IS NOT NULL;
