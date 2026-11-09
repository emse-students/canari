### Fixed - an iOS release build restores the Swift package cache, and the wasm-pack download retries

`ios.yml` restores, read-only, the SwiftPM cache `compile-ios-app` saves on `main`, and `scripts/install-wasm-pack.sh` retries a transient answer: the 504 that failed main's iOS compile on the `v1.6.9-alpha.1` bump came from that download ([cicd](docs/wiki/cicd.md#the-ios-release-build-restores-swiftpm-it-never-saves-it-2026-11-09)).
