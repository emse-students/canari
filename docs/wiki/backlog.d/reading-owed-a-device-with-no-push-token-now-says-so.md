## P2 - native devices with no push token stay silent: a fifth cause

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

**Read again 2026-11-14, after the `1.6.12` deploy (read-only):** of the 194 native devices that fetched from chat-delivery since the deploy, TWO hold no `push_token` row - an Android `1.6.10` and an iOS `1.6.7` device, both with a KeyPackage of 2026-11-12/13, neither revoked, both already seen in the first read - and still not ONE `[PUSH_UNAVAILABLE]` line on production. More than one device, silent across two deploys: by this entry's own rule that is a FIFTH cause, a token lost after registration (or never asked) on a path that reports nothing. Next: read each device's own log for its `[Push]` lines (the Mi 9T reproduces the Android shape if a token row can be removed on dev), and find which writer deletes a `push_token` row without the device learning it.
