### Added - a pull request touching native Apple code now compiles the iOS app

A compile-only, unsigned iOS job (`compile-ios-app`) in `ci.yml` feeds `CI passed`, so a Swift error fails before the merge instead of at the release cut; it skips cleanly when no Apple file changed ([cicd](docs/wiki/cicd.md#a-pull-request-compiles-the-ios-app-unsigned-compile-ios-app-2026-11-04)).
