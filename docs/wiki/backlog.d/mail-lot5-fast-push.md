## P2 - mail lot 5: what the fast mail push still owes

target: 1.8.4

Built in the lot 5 pull request ([mail-client-transport](../mail-client-transport.md#as-built---lot-5)).
Owed, in order:

1. **The owner's one-off procedure** (the backlog's owed table), then the lead's live alert probe on
   Partage: the filter rule's notice delivered to the EXTERNAL alert domain, and the user's rules
   reading back identical after a round trip.
2. **The readings on both phones** with `mail_push = cloudflare` on dev: a mail arrives, the
   notification names its sender within seconds; a device revoked from another forgets the mailbox
   (Android: the sealed copy erased by `NativeMailWatcher.forget`).
3. **Lot 4b's boot resume reads the persistent choice**: `MailWatchService.resumeIfArmed` resumes
   the persistent watch whenever a sealed copy exists, so with `cloudflare` and "Connexion
   permanente" off a reboot runs it anyway (battery, nothing lost). Done when a reboot with the
   choice off leaves no foreground service on the Mi 9T.
