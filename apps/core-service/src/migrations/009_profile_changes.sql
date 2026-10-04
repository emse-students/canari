-- Migration 009: the audit trail of an admin's profile edit.
--
-- WP4 of the profile reform (docs/wiki/profiles-and-access.md, decisions D9 and D10): an admin edits a
-- person's MiConnect profile from Canari, which writes authentik (the source of truth) and then this
-- service's own row. "Every change is traced (who, what, when)" - this is the trace.
--
-- ONE ROW PER APPLIED EDIT, written in the same transaction as the `users` row it describes.
-- `before` is what AUTHENTIK held when the edit was read (null when it held no profile), `after` what
-- was written: both are the version-1 profile shape, whole, so a row answers "what did this person
-- look like" without joining anything.
--
-- No foreign keys: `users.id` is the OIDC subject (a varchar), and account deletion must not be
-- blocked by, nor silently erase, the record of what an admin did to it.
--
-- Idempotent: the deploy ledger replays a file whose predecessor failed mid-run.

CREATE TABLE IF NOT EXISTS profile_changes (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "userId"   VARCHAR(255) NOT NULL,
    "actorId"  VARCHAR(255) NOT NULL,
    "before"   JSONB,
    "after"    JSONB NOT NULL,
    "at"       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "IDX_profile_changes_user_at" ON profile_changes ("userId", "at" DESC);
