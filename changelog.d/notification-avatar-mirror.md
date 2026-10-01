### Added - a face the app has shown reaches the Android notification without the network

The foreground writes each avatar it loads into the same native cache file the notification reads, through `store_avatar_mirror` ([mobile](docs/wiki/frontend/mobile.md#the-face-on-a-notification-and-what-happens-when-there-is-none)).
