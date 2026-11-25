### Fixed - MiGallery's and Le Cercle's access policy is re-read at every token refresh

authentik's `refresh_token` grant evaluates no application binding, so a refresh token would have
outlived the cotisant gate (D43). The two providers' `offline_access` scope is now one mapping that runs
the application's own access check at each refresh and answers `invalid_grant` to a person it refuses,
driven in CI by `test-refresh-gate.py` ([authentik](docs/wiki/infrastructure/authentik.md#the-gate-is-re-read-at-a-token-refresh-181)).
