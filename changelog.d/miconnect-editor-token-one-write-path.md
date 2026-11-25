### Security - the MiConnect profile editor token writes through one allowlisted path

The token Canari edits profiles and marks Alumni duplicates with loses its global user-change permission: it writes a profile, a name or a merge mark on a person, non-superuser account through one MiConnect flow, and a daily check reports any other grant or write ([authentik](docs/wiki/infrastructure/authentik.md#the-profile-editors-one-write-path-181)).
