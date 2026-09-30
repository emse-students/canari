### Fixed - iOS reports its real safe areas, so nothing sits on the home indicator

The iPhone's WebView was inset below the status bar by UIKit, which made every
`env(safe-area-inset-*)` read 0: the post composer's "Publier" reached into the home indicator. The
page is now laid out edge to edge, as on Android ([parity §1.1](docs/wiki/frontend/android-ios-parity.md)).
