### Fixed - iOS tells the page where the home indicator is

WebKit reported every safe area as 0 in the iPhone's WebView, so the post composer's "Publier" sat in
the home indicator. The native layer now publishes the real bottom inset
([parity §1.1](docs/wiki/frontend/android-ios-parity.md)).
