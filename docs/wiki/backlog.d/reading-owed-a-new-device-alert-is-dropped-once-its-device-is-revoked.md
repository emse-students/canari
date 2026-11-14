## Reading owed - a new-device alert is dropped once its device is revoked

target: 1.7.0

**What is built:** a new-device alert is dropped once its device is revoked (2026-11-12; [mls-protocol](../protocols/mls-protocol.md))

**The reading that closes it:** on the Mi 9T with an alert pending for another device of the bench account: revoke that device from another client, open `/notifications` - the row is gone and the console has `[DEVICE_NOTICE] alert dropped:` for it

**Prepared 2026-11-14, not read:** the Mi 9T's `/notifications` holds a pending "Nouvel appareil" alert (13:28) and W1 (the bench account's desktop client) is up, so the revoke can come from W1; what stopped the reading was the device list: `Gerer` on `/settings/security` opened no list over the harness click, and revoking blind could hit the phone's own device. Next: open that list by hand in W1, revoke the 13:28 device, reopen `/notifications` on the Mi.
