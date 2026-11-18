### Fixed - the dev deploy's smoke sign-in accepts MiConnect's terms instead of failing on them

The dev provider asks for the terms since #3839, and `v1.7.1-alpha.1`'s smoke sign-in died on that prompt. It now recognises that prompt alone, ticks it once per version and names any other stage it cannot answer ([cicd](docs/wiki/cicd.md#the-smoke-sign-in-wp-smoke-login-decided-2026-10-18)).
