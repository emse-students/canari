### Removed - the whole-list role-permission PUT and its retired-key drop

Every client admitted at `minClientVersion` 1.2.7 sends one `PATCH { key, granted }`, so
`PUT /api/channels/roles/:roleId/permissions` and `RETIRED_PERMISSIONS` go
([legacy-compatibility](docs/wiki/legacy-compatibility.md)).
