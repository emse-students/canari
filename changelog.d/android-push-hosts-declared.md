### Fixed - a calendar, agenda-validation or proposal notification tap did nothing on Android

The deep-link plugin drops any `fr.emse.canari://<host>` the config does not list, running or killed, and only `callback`, `stripe`, `chat`, `post` and `form` were listed: the tap opened the app and left it where it was. `posts`, `calendar`, `admin-agenda` and `proposals` are declared now, read on a Mi 9T ([device readings](docs/wiki/device-readings-2026-10.md)).
