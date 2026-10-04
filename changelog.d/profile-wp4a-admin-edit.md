### Added - a global admin can edit a person's MiConnect profile from Canari, at the source (production only)

`PUT /users/:id/profile` writes authentik through a least-privilege service account built by a blueprint, then Canari's row and an audit trail; dev refuses with a typed error because it shares production's MiConnect ([profiles-and-access](docs/wiki/profiles-and-access.md)).
