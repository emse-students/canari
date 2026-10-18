### Fixed - the iOS app delegate is kept alive after its re-assignment

`v1.3.0-alpha.1`/`-alpha.2` aborted on iOS whenever the accessibility tree was read (VoiceOver, XCUITest); the re-assigned app delegate is now held strongly, as Firebase does. Unverified on hardware ([backlog](docs/wiki/backlog.md)).
