-- Migration 017: the sessions an owner's DEVICE REVOCATION ended (docs/wiki/sessions.md, "A refresh
-- refused because the device was revoked says so").
--
-- An owner revoking a device ends every session bound to it (`AuthSessionsService.endDeviceSessions`)
-- by DELETING the rows - and a deleted row is the only record of why a session ended. So the device
-- itself, whose next refresh met "no such session", could not tell a revocation from an expiry: it
-- signed out like an expired session and kept every local store of an install its owner had just
-- disowned (MLS state, messages, ledgers). Its own revocation check could not answer either: the
-- access token it asks with died with the session.
--
-- One row per session ended BY AN OWNER'S DEVICE REVOCATION, written in the SAME transaction as the
-- delete, so the refresh refusal can say `DEVICE_REVOKED_BY_OWNER` - the cause carried to where the
-- device decides, from where it is known.
--
-- KEPT EXACTLY AS LONG AS IT CAN BE ASKED: a refresh token naming the session carries an `exp` at
-- most SESSION_TTL_SECONDS after the session's last rotation, which is before "endedAt". Past
-- "endedAt" + that TTL (+ skew) every such token fails to verify before the session is looked up,
-- so the row can never be read again, and the hourly session sweep deletes it.
--
-- No foreign key: the session row is deleted in the transaction that writes this one. Erased with
-- the account (`erasure-policy.ts`).
--
-- Idempotent: the deploy ledger replays a file whose successor failed mid-run.

CREATE TABLE IF NOT EXISTS device_revoked_sessions (
    "sessionId" UUID PRIMARY KEY,
    "userId"    VARCHAR(255) NOT NULL,
    "deviceId"  VARCHAR(128) NOT NULL,
    "endedAt"   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "IDX_device_revoked_sessions_ended"
    ON device_revoked_sessions ("endedAt");
