### Fixed - an association tab no longer shows its URL slug after in-app navigation, and the iOS share sheet's conversation suggestions can be donated

The route stops inventing a title from the slug and the page hands its loaded name to the tab; the app now declares `INSendMessageIntent` in `NSUserActivityTypes`, without which every donation was refused (code 1901), reading owed on the iPhone ([sharing](docs/wiki/frontend/sharing.md#share-suggestions-ios---lot-s5)).
