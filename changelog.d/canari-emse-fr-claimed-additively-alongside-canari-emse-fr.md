### Changed - `canari.emse.fr` is now claimed everywhere `canari-emse.fr` is

CORS, the public-app-URL host list, and both platforms' deep-link claims (App Links, Universal
Links, `tauri.conf.json`) now accept `canari.emse.fr` in addition to `canari-emse.fr`. Nothing is
removed and no default origin changes yet - the vhost still needs fixing before the new host
actually serves the site ([estate-migration](docs/wiki/infrastructure/estate-migration.md#7-phase-2---the-names)).
