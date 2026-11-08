-- Migration 150: a community's own display name for each of its three roles (owner, 2026-11-08).
--
-- docs/wiki/services/social-service.md, "A community may name its three roles".
-- `channel_roles.name` is the role's IDENTITY (the seeded Administrateur and Membre, and the moderator
-- name seeded with an accented e, see createWorkspace): every
-- permission decision, every role lookup (assignment, invitation) and every client of
-- `minClientVersion` 1.6.6 maps it to admin / moderator / member, and an unrecognised name folds to
-- `member` - so writing a free-text label into it would show an administrator as "Membre" on an
-- old client. The label therefore lives in its OWN column, read by nothing but the code that draws a
-- name: an old client ignores the field it does not know and keeps reading `name`.
--
-- NULL means "no name of its own": every client falls back to its localized default. Bounded at 40
-- characters (the server validates, and counts code points; the column is the safety net).
--
-- ADDITIVE: one nullable column, no default, no rewrite, no existing value touched. Idempotent for
-- CD (IF NOT EXISTS).

SET lock_timeout = '5s';

ALTER TABLE channel_roles ADD COLUMN IF NOT EXISTS "displayLabel" varchar(40);
