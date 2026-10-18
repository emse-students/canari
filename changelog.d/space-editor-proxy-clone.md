### Fixed - the space editor no longer crashes on opening (`DataCloneError`)

Every open of `/bookings/spaces/<id>/edit` crashed in `v1.3.0-alpha.2`: the draft `structuredClone`d a `$state` proxy. It now copies with `$state.snapshot`, and the layout's crash line names the route in the in-app log ([bookings-chantier](docs/wiki/bookings-chantier.md)).
