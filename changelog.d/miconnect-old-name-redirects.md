### Fixed - signing in through the School account on the old MiConnect name

The DSI replaced the CAS callback with the new host, so `auth.canari-emse.fr` answered 401 on the School login; its pages now `301` to `miconnect.emse.fr` while the token/userinfo/jwks endpoints stay served, and the brand domain follows ([estate-migration](docs/wiki/infrastructure/estate-migration.md#the-old-name-of-miconnect-redirects-and-the-dsi-replaced-the-cas-callback-2026-10-06)).
