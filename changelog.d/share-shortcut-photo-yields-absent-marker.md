### Fixed - launcher and share-sheet shortcuts finally receive their picture (a contact's photo, a group image, a community logo)

The Rust `publish_share_targets` command dropped the picture field before the Android side saw it, so
every shortcut was initials. A "no photo" remembered from a 404 also outlived `avatar-presence`;
a user known to have a photo now makes the native side drop it
([sharing](docs/wiki/frontend/sharing.md#the-picture-of-a-shortcut-absence-yields-to-presence)).
