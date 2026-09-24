### Fixed - login (and posts, uploads, presence) broke on `canari.emse.fr` because the web build baked in `canari-emse.fr` as the only API origin

`coreUrl()`/`gatewayUrl()`/`deliveryUrl()`/`socialUrl()` and two duplicated media-URL readers now
check the page's own origin before the build-time env var in any real browser, so one web build can
correctly serve both public hostnames instead of hardcoding the older one
([estate-migration](docs/wiki/infrastructure/estate-migration.md#the-frontend-bakes-one-absolute-origin-per-build-and-phase-2-gave-it-two---login-broke-2026-09-25)).
