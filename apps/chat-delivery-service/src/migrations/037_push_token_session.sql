-- Migration 037: the session that made a push registration (docs/wiki/sessions.md, "A session that
-- ends takes its device's push registration with it").
--
-- `POST /mls/push/register` writes the session id the caller's access token carries (its `sid`
-- claim, forwarded by nginx as `X-Session-Id` from core-service's verify), and the internal
-- end-of-session route deletes `WHERE "sessionId" = <the ended session>`. So ending a session removes
-- the registration THAT session made, and never a newer one a re-sign-in on the same device wrote:
-- the order of the two is fixed by the row itself, not by when each call arrives.
--
-- Nullable, and NO BACKFILL: no record says which session wrote an existing row. Such a row keeps
-- NULL until its device registers again (every app start re-registers when the token or the locale
-- changed, and every sign-in does). A row registered with an access token minted before `sid`
-- existed (an hour at most after the deploy) also stores NULL. A NULL row, or one bound to a session
-- that is gone, is ended with the device's next deliberate session end, by compare-and-delete.
--
-- No index: a device holds one row, an account a handful, and every delete is scoped by "userId"
-- first (the unique ("userId", "deviceId") index leads with it).
--
-- LOCK TIMEOUT: ADD COLUMN takes ACCESS EXCLUSIVE on `push_token`, which every send reads to find its
-- destinations. Waiting behind a long transaction would stall them behind the queued lock request, so
-- the migration gives up instead; the deploy then fails loudly and a re-run is safe (idempotent).
-- Asserted by `migrations.lock-timeout.spec.ts`.
SET lock_timeout = '5s';

ALTER TABLE "push_token" ADD COLUMN IF NOT EXISTS "sessionId" uuid;
