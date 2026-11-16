### Fixed - the container image scan no longer fails on four aiohttp advisories in the upstream authentik image

Authentik 2026.8.5, the newest release, still ships aiohttp 3.14.3 (fixed in 3.14.4), and we do not build that image. The four HIGH advisories are allowlisted by purl with a statement, and the entries retire themselves when a release ships the fix ([cicd](docs/wiki/cicd.md)).

The frontend dependency audit also drops its dead `GHSA-gcqx-w48m-w2h4` ignore: the audit no longer reports it, so the retirement step failed as designed.
