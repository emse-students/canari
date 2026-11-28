## P2 - mail lot 5: what the fast mail push still owes

target: 1.8.4

Built in the lot 5 pull request ([mail-client-transport](../mail-client-transport.md#as-built---lot-5)).
Owed, in order:

1. **The owner's one-off procedure** (the backlog's owed table), then the lead's live alert probe on
   Partage: the filter rule's notice delivered to the EXTERNAL alert domain, and the user's rules
   reading back identical after a round trip.
2. **The readings on both phones** with `mail_push = cloudflare` on dev: a mail arrives, the
   notification names its sender within seconds; a device revoked from another forgets the mailbox
   (Android: the sealed copy erased by `NativeMailWatcher.forget`), and one that signed in again
   before the forget arrived keeps it; a password changed in the webmail erases the iPhone's copy
   at the next push (`mail-refused`) instead of being retried.
3. **MAIL-N, the empty pushes**, on dev with `cloudflare` for a week of real mail: on Android the
   ratio `emptyTotal / doneTotal` of the `mail push metric` logcat line (a check that moved no cursor),
   on iOS the count of blank passive rows (`mail-nothing-new`, `mail-foreground`) against the mail
   notices shown. High priority stays while the ratio is small; a large one names its cause (the
   page or lot 4 taking the mail first, or a notice for a mail the inbox query does not show).
