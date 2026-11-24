## P2 - the cotisant gate is not re-read at a token refresh

target: 1.8.1

**Found 2026-11-24** on the re-review of #4001, read in authentik 2026.8.6's source: the
`refresh_token` grant evaluates no application policy, so a MiGallery or Le Cercle client that holds
a refresh token keeps its access past the day the D43 gate would refuse it, until that token expires
or is revoked. What each site's provider does with `offline_access` and its refresh validity decides
how long; the measurement and the source lines are on
[authentik](../infrastructure/authentik.md#the-alumni-sso-as-built-for-180-d42-d49-owner-2026-11-23).
Lifted by a test that refreshes a token for a person the gate now refuses and expects `invalid_grant`.
