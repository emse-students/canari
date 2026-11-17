### Fixed - a salon banner on iPhone no longer goes blind right after the app is opened

Each time the app came to the foreground it copied its own seed file over the notification
extension's, erasing the seeds the extension had just opened, so the next salon notification read
"Nouveau message dans #salon". iOS now keeps one seed file, shared by both
([channel-encryption](docs/wiki/protocols/channel-encryption.md#27-the-iphone-held-two-seed-mirrors-and-the-one-without-the-extensions-seeds-won---fixed-2026-11-17)).
