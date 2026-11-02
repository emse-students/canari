-- canari:hold-for-owner - a backfill of every association_members row holding MANAGE_MEMBERS.
-- Migration 124 : EDIT_PROFILE (1 << 12 = 4096)
-- DATA migration (owner, 2026-11-02): `PATCH /associations/:id` and the logo routes move from
-- MANAGE_MEMBERS (1 << 2 = 4) to the new EDIT_PROFILE, so every member row holding MANAGE_MEMBERS
-- also receives EDIT_PROFILE and nobody loses the right to edit the profile they edit today.
-- It ORs ONE bit in and touches no other. Idempotent: rows already holding bit 12 are skipped, so a
-- second run rewrites nothing.
-- Read-only count of the rows it rewrites (run BEFORE applying):
--   SELECT COUNT(*) FROM association_members
--   WHERE ("permissions" & 4) <> 0 AND ("permissions" & 4096) = 0;

BEGIN;

UPDATE association_members
SET "permissions" = "permissions" | 4096
WHERE ("permissions" & 4) <> 0
  AND ("permissions" & 4096) = 0;

COMMIT;
