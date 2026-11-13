### Fixed - the image scan allowlists the 34 libpq5 advisories of 2026-11-13 in authentik 2026.8.5

Debian fixed them in libpq5 17.12, which only a rebuilt authentik release can carry; each entry is scoped to that package by its purl and retires with the next upgrade ([cicd](docs/wiki/cicd.md)).
