### Fixed - a commit waiting for its answer no longer holds every other conversation's messages

While one group's commit request waited on the network (up to ~1 min), messages in every other conversation were neither decrypted nor acknowledged, and their push duplicated. The commit now lends the MLS lock to those frames while it waits ([mls-protocol](docs/wiki/protocols/mls-protocol.md#a-commit-waiting-on-the-network-lends-the-mls-lock-to-other-groups-frames)).
