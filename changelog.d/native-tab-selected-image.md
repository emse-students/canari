### Fixed - the iOS tab bar's selected tab is drawn in yellow

The selected bitmap was patched into the plugin's Swift half only, and its Rust half dropped it on the way; a test now compares both ([mobile](docs/wiki/frontend/mobile.md#the-native-ios-tab-bar)).
