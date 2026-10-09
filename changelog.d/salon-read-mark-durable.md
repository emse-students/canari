### Fixed - a salon read mark that failed or was cut short is no longer lost, so read messages stay read after a reload

The mark is now owed durably from the instant it is decided and delivered before the unread counts are asked; see [offline-and-weak-network](docs/wiki/frontend/offline-and-weak-network.md).
