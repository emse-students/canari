### Fixed - CI: the image scan no longer fails when its advisory feed forgets a suppressed CVE

The CVE-2026-97054 gosu entry was added, removed as dead, restored and dropped again by the scanner's data, failing every pull request each time (the entry stays; the earlier "removed" line above is superseded). An allowlist entry is now dead only when the package version it covers is in no scanned image; an advisory the feed merely stopped reporting is kept, with one log line naming the database version ([cicd](docs/wiki/cicd.md#a-suppression-is-dead-when-the-image-moved-not-when-the-feed-forgot-2026-11-21)).

Every allowlist entry now carries the package version in `purls:`, which Trivy enforces itself, and the check matches `paths:` against where the package sits, so a package of the same name in another image no longer keeps an entry alive.
