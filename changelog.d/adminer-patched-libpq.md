### Security - production's adminer runs upstream's image with Alpine's `libpq` upgraded to 18.7

Upstream's newest adminer carried `libpq 18.6-r0` and 38 HIGH PostgreSQL advisories, failing the image scan on every pull request; every release now builds `infrastructure/local/Dockerfile.adminer` (the same digest plus `apk upgrade libpq`) and the scan reads the built image, until upstream ships the fix ([legacy-compatibility](docs/wiki/legacy-compatibility.md#removal-once-upstream-adminer-ships-libpq--187-r0---the-adminer-image-this-repository-builds-owner-2026-11-13)).
