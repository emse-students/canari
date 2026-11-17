### Fixed - removing a login whose device the server no longer lists now erases that machine

Measured on production: the old PC that came back on 2026-08-22 with its whole store had never been revoked - its panel row only signed a login out. Such a row now revokes the device id it names, as a listed device is revoked ([auth](docs/wiki/frontend/modules/auth.md#a-removed-row-whose-device-the-server-no-longer-lists)).
