## Reading owed - a device with no push token now says so

target: 1.7.0

**What is built:** a device with no push token now says so

**The reading that closes it:** after the next release a tokenless device either acquires one or prints `[PUSH_UNAVAILABLE]` naming a cause; silence with a tokenless device still in `key_package` means a FIFTH cause

**Read on production 2026-11-14** (15.5 hours after the `v1.6.11` deploy): of the 84 native
devices that fetched history, 83 hold a `push_token` row; ONE does not - an iOS `1.6.6` device,
still in `key_package`, not revoked - and no `[PUSH_UNAVAILABLE]` line was written at all. That is
this entry's "silence" case, but one device cannot separate a fifth cause from the documented one:
an app closed inside the four-minute registration ladder reports nothing
(`PushNotificationService.ts`). Owed: the same read after the next stable; the same device silent
across days, or more than one, is the fifth cause.
