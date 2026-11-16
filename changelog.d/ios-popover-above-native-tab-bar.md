### Fixed - a post's menu and the profile's menu on iOS end above the native tab bar

The floating panels were laid out against the whole screen, so their last item sat under the UIKit tab bar, which no web layer can cover. Panels now subtract the band the bar reports, as they do the keyboard's ([mobile](docs/wiki/frontend/mobile.md)).
