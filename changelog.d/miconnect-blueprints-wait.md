### Fixed - the MiConnect blueprints job no longer hangs for 25 minutes

Its wait for authentik's default blueprints had no end but the job timeout, so one lost race at boot
(a blueprint left in `error`, never retried) failed three PRs. It now re-applies what is stuck once,
naming it, and fails in minutes with the evidence otherwise
([authentik](docs/wiki/infrastructure/authentik.md#the-configuration-is-code-infrastructureauthentikblueprints-2026-09-30)).
