## P3 - deleting one's account logs a false error: the push deregistration "refused" with a 401

target: 1.7.1

Read on dev, `1.7.0-alpha.12`, sitting S7 (2026-11-18,
[readings](../device-verification.md#the-web-and-phone-readings-of-2026-11-18-s7-170-alpha12-the-last-sitting-before-the-stable)):
a throwaway test account deleted from Settings > Supprimer mon compte on the Mi 9T logged, at error
level, in the same second as the local wipe,

```
[Push] FCM token deregistration refused: HTTP 401 - the server still lists device tauri-<id>… as a push destination
```

The account was already deleted on the server when `stopPushService` (`PushNotificationService.ts`)
sent `DELETE /api/mls/push/unregister/<deviceId>` with its bearer, so the 401 is the expected answer and
the sentence's claim ("the server still lists device ... as a push destination") is about a device of
an account that no longer exists. A line that accuses on every honest account deletion is the noise the
rules forbid, and it reads like the real failure the branch reports at a sign-out (#3144).

**Fix direction:** carry the discriminator to the call - the account-deleted wipe (`clearAuth` with
`account-deleted`) knows the server already erased the account's devices, so it skips the
deregistration (or the deletion deregisters first, as a sign-out does since #3144). Whether dev kept a
push-token row for the deleted account's device was not read; the erasure path should be asserted to
remove it (`account-erasure.ts`), which is what makes skipping the call correct.

**Not shown a regression:** the line and its order came with #3144 (2026-11-08, before `v1.6.12`).
