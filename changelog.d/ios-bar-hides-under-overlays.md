### Fixed - the iOS tab bar no longer sits over the composer and every dialog

The native bar is drawn above the WebView, so no modal could cover it: it hid "Publier" in the post
composer and stayed tappable over every dialog. It now hides while anything covers the screen, and the
composer's attachment row fades on the side that scrolls ([mobile](docs/wiki/frontend/mobile.md#the-native-ios-tab-bar)).
