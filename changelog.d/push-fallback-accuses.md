### Fixed - a blind salon notification is always counted, and the push service's warnings reach the exported log

Every blind salon banner ("Quelqu'un" / "Nouveau message dans #salon") is now reported with why the open did not show the message, a withdrawn reaction posts no banner, and the Android push service's warnings and errors are carried into the in-app log ([channel-encryption](docs/wiki/protocols/channel-encryption.md), [mobile](docs/wiki/frontend/mobile.md#the-push-services-lines-in-the-in-app-log-2026-11-04)).
