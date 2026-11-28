-- Migration 059: the mail alert tokens, mail lot 5 (docs/wiki/mail-client-transport.md#as-built---lot-5).
--
-- An account that turns fast mail notifications on, while `platform_config.mail_push = 'cloudflare'`,
-- points its OWN Zimbra new-mail alert at an opaque address `n-<token>@<alert domain>`. Cloudflare's
-- Email Worker posts that token to `POST /api/hooks/mail-alert`, and this service sends an EMPTY
-- push (`{type: 'mail'}`) to the account's subscribed devices. A token is useless alone: it names
-- no person, carries nothing, and only ever triggers an empty push to its owner.
--
-- `mail_alert_token`: ONE live token per account (an account holds one Canari filter rule), as
-- the SHA-256 of the token - the token itself is never stored, so a database copy cannot be used to
-- trigger pushes, and a hook post is matched by hashing what it carries. Rotated by a subscription
-- that names a new token (the row is replaced). Deleted when the account's last subscribed device
-- leaves, and at the account's erasure.
--
-- `mail_alert_device`: which of the account's devices want the push. A FOREIGN KEY to the device's
-- push registration, ON DELETE CASCADE: a session end, a revocation, an invalid token or an account
-- erasure takes the subscription with the registration (the push_envelope rule, migration 046).
--
-- ADDITIVE ONLY: two new tables. A release that predates them reads neither, so a rollback is safe.
-- LOCK TIMEOUT: the foreign key takes SHARE ROW EXCLUSIVE on `push_token`, which every send reads;
-- the migration gives up after five seconds rather than queue behind a long transaction.
-- Idempotent: the deploy ledger replays a file whose predecessor failed mid-run.
SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "mail_alert_token" (
    "userId"    varchar(255) PRIMARY KEY,
    "tokenHash" char(64) NOT NULL,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "UQ_mail_alert_token_hash" UNIQUE ("tokenHash")
);

CREATE TABLE IF NOT EXISTS "mail_alert_device" (
    "userId"    varchar(255) NOT NULL,
    "deviceId"  varchar NOT NULL,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "PK_mail_alert_device" PRIMARY KEY ("userId", "deviceId"),
    CONSTRAINT "FK_mail_alert_device_push_token" FOREIGN KEY ("userId", "deviceId")
        REFERENCES "push_token" ("userId", "deviceId") ON DELETE CASCADE
);
