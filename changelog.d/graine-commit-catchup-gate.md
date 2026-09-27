### Fixed - A shut phone behind by one commit catches up again, so salon notifications show their text

The background catch-up checked membership in a table that never lists a community's key group, and
answered 403 for all eight of them on production; any newcomer left every shut phone unable to read
a salon seed until the app was reopened ([channel-encryption](docs/wiki/protocols/channel-encryption.md#16-a-shut-phone-one-commit-behind-could-never-catch-up-in-any-community---fixed-2026-09-27)).
