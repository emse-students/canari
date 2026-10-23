-- Migration 015: the server's kill switch for lives (owner, 2026-10-21).
--
-- WHY. Until now lives were off in production by two locks fixed at build and deploy time: the
-- server's `LIVE_ENABLED` (rendered per estate by `infrastructure/deploy/render-env.sh`) and the
-- client's `LIVE_ENABLED` (`frontend/src/lib/features.ts`). Once both are on, stopping lives again
-- would take a stable store release. The owner decided that lives get a RUNTIME switch before they
-- are enabled in production, exactly like calls (migration 014). This column is that switch, one
-- row, read on every live request by social-service (`lives/lives-mode.ts`) and, through
-- social-service's `GET /api/internal/lives/mode`, by media-service's two live segment routes; it is
-- published to clients through `GET /api/version` so they hide what the server would refuse.
--
--   off  every live route answers 404, as if `LIVE_ENABLED` were off. The default, so every
--        existing row - production's and dev's - is closed until a global admin opens it at
--        `/admin/platform`.
--   on   the live routes answer, PROVIDED the estate's `LIVE_ENABLED` deploy lock is also on:
--        the two locks are ANDed, neither replaces the other.
--
-- A mode rather than a boolean, as `calls_mode`: a later state (a viewers-only mode, say) is a new
-- value in the CHECK, not a new column.
--
-- ADDITIVE ONLY: a column with a default, and a CHECK so a value no service understands cannot be
-- written by hand. A release that predates this column never reads it, so a rollback is safe.
--
-- Idempotent: the deploy ledger replays a file whose predecessor failed mid-run.

ALTER TABLE platform_config
  ADD COLUMN IF NOT EXISTS lives_mode VARCHAR(16) NOT NULL DEFAULT 'off';

ALTER TABLE platform_config DROP CONSTRAINT IF EXISTS "CHK_platform_config_lives_mode";
ALTER TABLE platform_config
  ADD CONSTRAINT "CHK_platform_config_lives_mode"
  CHECK (lives_mode IN ('off', 'on'));
