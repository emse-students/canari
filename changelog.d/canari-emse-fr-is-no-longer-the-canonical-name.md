### Changed - `canari.emse.fr` is the canonical name everywhere, and the old one is compatibility only

Pages served from `canari.emse.fr` were declaring `canari-emse.fr` in their canonical tag and
`og:url`, telling every search engine and link unfurler that the real page lived on the host
browsers are about to be redirected away from. Share links, the canonical origin, `robots.txt` and
the bare-domain linkifier now carry the new name; the CORS list, the deep-link claims and the
`wss://` allowlist carry BOTH, because apps already installed on a phone still call the old one
([estate-migration](docs/wiki/infrastructure/estate-migration.md#7-phase-2---the-names)).
