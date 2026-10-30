### Changed - a pre-release is pinned on its release branch, so a merge during a release no longer kills it

Every bump now pushes `release/vX.Y.Z` and the `land` job carries the version to `main` afterwards, forward only; gate 2 asks containment, and refuses a pre-release older than one already released ([cicd](docs/wiki/cicd.md#a-pre-release-is-pinned-on-its-release-branch-decided-2026-10-30)).
