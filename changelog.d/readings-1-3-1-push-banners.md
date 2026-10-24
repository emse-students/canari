### Changed - the v1.3.1-alpha.5 push reading: in-app notifications pass, the FCM banner is owed on production

On both bench phones, the notification raised inside the app, its tap and the message seen on return all pass. Dev
has no Firebase secret, so the background banner, the reaction and the reel text changed by #2112 cannot be read
there. That code is unit-tested and no shipped client sends a reel message yet ([readings](docs/wiki/device-readings-2026-10.md)).
