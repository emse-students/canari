### Changed - the iOS builds move to Xcode 27 and the iOS 27 SDK

App Store Connect will refuse uploads built with an older SDK from April 2027 (ITMS-90725); both
Apple jobs now run on the `xcode-27` runner and require Xcode 27 ([cicd](docs/wiki/cicd.md#the-ios-toolchain-is-pinned-xcode-27-since-171)).
