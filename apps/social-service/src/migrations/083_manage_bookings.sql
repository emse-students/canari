-- Migration 083 : MANAGE_BOOKINGS (1 << 11 = 2048)
-- DATA migration (decision D39, bookings-chantier): every member row holding MANAGE_FORMS
-- (1 << 4 = 16) also receives MANAGE_BOOKINGS. Idempotent: rows already holding bit 11 are skipped.
-- Read-only count of the rows it rewrites (run BEFORE applying):
--   SELECT COUNT(*) FROM association_members
--   WHERE ("permissions" & 16) <> 0 AND ("permissions" & 2048) = 0;

BEGIN;

UPDATE association_members
SET "permissions" = "permissions" | 2048
WHERE ("permissions" & 16) <> 0
  AND ("permissions" & 2048) = 0;

COMMIT;
