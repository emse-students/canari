-- Migration 032: the class of a user's school address, for the mail client's relay.
--
-- docs/wiki/mail-client-transport.md#eligibility (owner, 2026-11-27). MiConnect hands Canari's
-- providers the school address of a CAS-created account (claim `school_mail`); core-service keeps
-- ONLY its class here, refreshed at every sign-in - never the address (charter principle 1). The
-- relay admits a socket for a 'student' or 'staff' account; NULL is "not offered", which is every
-- account until MiConnect's blueprint emits the claim and the person signs in again.
--
-- LOCKS. ADD COLUMN of a nullable column with no default is a catalogue change (no rewrite), under
-- ACCESS EXCLUSIVE on `users` until COMMIT; `users` is read on every request, so the migration gives
-- up after 5 s rather than queue every login behind a long transaction. The re-run is safe.
--
-- IDEMPOTENT: the deploy ledger replays a file whose predecessor failed mid-run. ADDITIVE: every
-- older image ignores the column.

SET lock_timeout = '5s';

ALTER TABLE users ADD COLUMN IF NOT EXISTS "mailClass" VARCHAR(16);
