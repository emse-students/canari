### Fixed - logging in via `canari.emse.fr` was refused with a redirect_uri error

The `Canari` OAuth2 provider only listed `canari-emse.fr`'s callback. Added
`https://canari.emse.fr/auth/callback` alongside it (additive, mirrors the estate migration's other
host-claiming steps). Found in the process: `redirect_uris` must be REASSIGNED as a whole list, not
appended to in place - the attribute is rebuilt fresh from stored JSON on every read, so mutating
the returned list and calling `.save()` silently keeps the old value
([authentik](docs/wiki/infrastructure/authentik.md#the-three-canari-providers-and-what-each-one-lets-a-client-come-back-to)).
