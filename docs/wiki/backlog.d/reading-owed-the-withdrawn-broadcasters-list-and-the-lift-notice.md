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
