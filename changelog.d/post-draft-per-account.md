### Fixed - a post draft no longer follows the device to the next account

The composer draft was one per device, so a second account opening "Nouvelle publication" read the first one's text. It is now keyed by user id; the old unowned value is dropped. See [posts](docs/wiki/frontend/modules/posts.md).
