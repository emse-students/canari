### Fixed - MiGallery and Le Cercle offer no refresh grant, which would bypass their access policy

authentik's `refresh_token` grant evaluates no application binding, so a refresh token would outlive the
cotisant gate (D43). Neither site refreshes; their providers now list `authorization_code` alone, and
`test-refresh-gate.py` asserts every provider of a gated application closed and probes its token endpoint
([authentik](docs/wiki/infrastructure/authentik.md#the-refresh-grant-is-closed-on-gated-providers-181)).
