### Fixed - the iOS tab bar's show and hide can no longer apply out of order

Both async commands now carry the same rising `seq` as the interaction switch, and the plugin drops a call older than the last one it applied ([mobile](docs/wiki/frontend/mobile.md#the-native-ios-tab-bar)).
