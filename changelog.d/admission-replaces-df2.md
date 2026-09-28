### Fixed - a device added while its phone was dead is a recipient from the add commit's epoch, not from a five-minute replay

The add commit names the devices it adds and the server queues each every frame sealed from that epoch on, so a
shut phone is pushed the messages it can open; the time-windowed replay at activation (DF2) is deleted
([channel-encryption](docs/wiki/protocols/channel-encryption.md#20-whoever-admits-a-newcomer-welcomes-them---decided-by-the-user-2026-09-27)).
