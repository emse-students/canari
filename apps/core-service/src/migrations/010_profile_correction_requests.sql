-- Migration 010: the queue of requests to correct a profile.
--
-- WP4b of the profile reform (docs/wiki/profiles-and-access.md, D10): only an admin edits a profile,
-- so a person who sees a wrong campus, formation or name asks for the correction from a button on
-- their own profile. The request lands here, an admin applies it (an edit, WP4a) or refuses it with a
-- note, and the person is notified either way.
--
-- ONE OPEN REQUEST PER PERSON ('pending', or 'applying' while an admin holds the claim), enforced by the partial unique index and not by a check in the code:
-- two clicks, or two tabs, must not put the same person in the queue twice. A resolved request frees
-- the slot, so asking again later is always possible.
--
-- No foreign keys, for the same reason as `profile_changes` (009): `users.id` is the OIDC subject,
-- and deleting an account must not be blocked by the queue.
--
-- `profile_changes.requestId` names the request an applied edit answered, so the audit trail reads
-- "this edit was asked for, and this is what the person wrote".
--
-- Idempotent: the deploy ledger replays a file whose predecessor failed mid-run.

CREATE TABLE IF NOT EXISTS profile_correction_requests (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "userId"         VARCHAR(255) NOT NULL,
    message          TEXT NOT NULL,
    status           VARCHAR(16) NOT NULL DEFAULT 'pending',
    "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT now(),
    "resolvedAt"     TIMESTAMPTZ,
    "resolvedBy"     VARCHAR(255),
    "resolutionNote" TEXT,
    CONSTRAINT "CHK_profile_correction_status" CHECK (status IN ('pending', 'applying', 'applied', 'refused'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_profile_correction_one_pending"
    ON profile_correction_requests ("userId") WHERE status IN ('pending', 'applying');
CREATE INDEX IF NOT EXISTS "IDX_profile_correction_status_created"
    ON profile_correction_requests (status, "createdAt");

ALTER TABLE profile_changes ADD COLUMN IF NOT EXISTS "requestId" UUID;
