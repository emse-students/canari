### Added - every Swift file is parsed on each pull request

`swiftc -parse` runs over all tracked `.swift` files in the always-on CI script job, so a syntax error in the iOS tree is found at the pull request and no longer by an App Store build; the two Swift test targets are measured to be the Xcode template ([mobile](docs/wiki/frontend/mobile.md#cicd)).
