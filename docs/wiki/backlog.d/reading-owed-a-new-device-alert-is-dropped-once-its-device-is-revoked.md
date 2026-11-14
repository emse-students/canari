## Reading owed - a new-device alert is dropped once its device is revoked

target: 1.7.0

**What is built:** a new-device alert is dropped once its device is revoked (2026-11-12; [mls-protocol](../protocols/mls-protocol.md))

**The reading that closes it:** on the Mi 9T with an alert pending for another device of the bench account: revoke that device from another client, open `/notifications` - the row is gone and the console has `[DEVICE_NOTICE] alert dropped:` for it
