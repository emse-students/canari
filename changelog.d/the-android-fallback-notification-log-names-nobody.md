### Fixed - the Android log no longer carries a sender's name

`CanariFirebaseMessagingService.kt` logged the whole fallback notification text, which holds the
sender's real display name (`Fallback notification: Nouveau message de <name>`). It now logs the text's
length, whether a name was available and the 8-character group prefix.
