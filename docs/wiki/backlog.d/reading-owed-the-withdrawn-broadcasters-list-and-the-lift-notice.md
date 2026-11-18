## Reading owed - the withdrawn broadcasters list, its lift, and the "restored" notice

target: 1.7.0

Built for `1.7.0` (completes #3772, live moderation): a staff read of a broadcaster's standing with no
report in between, the tab "Diffusion retirée" of `/admin/moderation` listing the withdrawn accounts
with the lift, the three success toasts drawn as success, and a `live_reinstated` notice (bell row and
push) written by a real lift ([live](../frontend/modules/live.md#the-moderation-client-wp-l8s-client-half-2026-10-19),
[lives](../services/lives.md#the-three-pushes-a-broadcaster-gets-wp-l8b)). The server, the component and
the notice are covered by tests; the integration spec needs PostgreSQL and runs in CI.

Closing readings, each `PASS` or a new entry:

1. **The list, on a dev web staff seat (platform admin)**: with a broadcaster withdrawn and EVERY report
   naming them reviewed or dismissed, open `/admin/moderation`, tab "Diffusion retirée": the account is
   listed with its name, date, reason and cuts; "Rétablir le droit" asks one confirmation naming them,
   the toast reads as a success (neutral, not red), and the list re-reads without the account. A BDE
   staff seat lists only the people of its own spaces.
2. **The notice, on the Mi 9T and the iPhone 12** (a `1.7.0` build; a dev write goes to the harness's
   written-ids list): after the lift the broadcaster gets the push "Droit de lancer un live rétabli",
   its tap opens the notifications list, and the bell row reads "Votre droit de diffuser a été rétabli
   ; une suspension en cours reste appliquée jusqu'à sa fin." with no avatar of nobody; a second lift
   writes nothing.

**Sitting S5, 2026-11-18 (`1.7.0-alpha.12`, build `100700012` on both phones, [readings](../device-verification.md#the-phone-readings-of-2026-11-18-s5-170-alpha12-the-alpha12-fixes-on-both-phones)):
reading 2 `PASS` on both phones, reading 1 `PASS` but its last sentence.** A withdrawal row was written on dev for
`alpha`, then for `gamma` (no cut on record; every report naming them reviewed or dismissed, `gamma`'s one pending
live report dismissed from the queue first). **The list:** the platform-admin seat (W4, English UI) listed
`alpha` under "Broadcast withdrawn" with name, date, reason "Other" and "Cuts on record: 0 of 3"; "Restore the
right" asked once, naming the account; the toast read "The right to broadcast was restored." on the neutral
surface (`bg-cn-surface`, not red); the tab re-read to "No right to broadcast is withdrawn at the moment." A BDE
staff seat (W5, `delta`, French UI) listed `gamma` under "Diffusion retirée" and lifted it the same way ("Le droit
de diffuser a été rétabli."). **The notice:** the Mi 9T got "Droit de lancer un live rétabli" on `canari_social`
(`deepLink=fr.emse.canari://notifications`), the iPhone the same text (`[CanariNSE] didReceive type=social`,
`outcome=server-content`); each tap opened the list, whose row read "Votre droit de diffuser a été rétabli ; une
suspension en cours reste appliquée jusqu'à sa fin." with the `video-off` icon and no avatar. **A second lift
writes nothing:** the same account lifted again from a second, stale tab answered "The right to broadcast was no
longer withdrawn." and the bell rows stayed at one (`post_notifications`), no push. **Left:** that a BDE staff
seat does NOT list a withdrawn account outside its own spaces (only the positive case was seen; the narrowing is
covered by the server's tests).
