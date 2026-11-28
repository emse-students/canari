## P2 - mail lot 5: what the fast mail push still owes

target: 1.8.4

Built in the lot 5 pull request ([mail-client-transport](../mail-client-transport.md#as-built---lot-5)).
Owed, in order:

1. **Lot 4b's handoff on Android**: `MailPushHandoff.kt` answers a typed `Unavailable` until
   `NativeMailWatcher.checkOnce` / `forget` exist on main; then two lines. Done when a `mail` push
   on the Mi 9T shows the mail's sender and a `mail-forget` erases the sealed copy.
2. **The owner's one-off procedure** (the backlog's owed table), then the lead's live alert probe on
   Partage.
3. **The readings on both phones** with `mail_push = cloudflare` on dev: a mail arrives, the
   notification names its sender within seconds; a device revoked from another forgets the mailbox.
