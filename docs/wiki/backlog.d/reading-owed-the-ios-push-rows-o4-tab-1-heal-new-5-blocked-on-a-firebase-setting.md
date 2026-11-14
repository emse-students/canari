## Reading owed - the iOS push rows (O4, TAB-1, HEAL-NEW-5), a development-signed build waits on a Firebase setting

target: 1.7.0

**What is built:** the iOS push rows (O4, TAB-1, HEAL-NEW-5), **a development-signed build waits on a Firebase setting**

**The reading that closes it:** the development-signed bench build gets `[PUSH_SEND] FCM failed ... Invalid APNs credential` for sandbox tokens while production sends 366 `platform=ios` with 0 failures: the APNs key is missing in the DEVELOPMENT slot (the fix is INFERRED, not read; [the owed click](../backlog.md#owed-to-the-user---decisions-rotations-and-one-off-clicks)). After it, resend the test DM: success = `FCM sent ... platform=ios` plus an `apsd` line in the iPhone syslog. Blocked, on a development-signed build only, until then (a TestFlight pre-release on dev can take them, 2026-11-14): O4, O11, O13, the NOTIF rows, MENTION-2/3, LIFE-2/3/5/8
