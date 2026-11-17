## Reading owed - live moderation: the three broadcaster pushes, the withdrawal lift and the lives switch

target: 1.7.0

What is left of WP-L8 (live moderation), whose code is complete since 2026-11-17: the client's two
start refusals and the pre-live standing (2026-11-15), the broadcaster hiding a chat line and staff
hiding one from the viewer (WP-L6, `POST /api/lives/:id/messages/:messageId/hide`), and the control
lifting a withdrawal in `/admin/moderation`
([live](../frontend/modules/live.md#the-moderation-client-wp-l8s-client-half-2026-10-19)). The gate
list is [live-production](../frontend/modules/live-production.md#2-the-gates-each-with-its-evidence);
the viewer cap is [its own entry](live-viewer-cap-lifted-in-measured-steps.md). Lives stay a release
blocker until G9 closes (G7 and G8 closed 2026-11-17): [the phone-reading entry](reading-owed-lives-on-both-phones-watching-broadcasting-chat-and-reactions.md). Read 2026-11-17 and
no longer owed: dev's `[LIVE_REPORT_AGE]` line (`pending=0` hourly, G4), and dev's `lives_mode` row
open (`on`, published by `/api/version` as `lives.mode`).

Closing readings, each `PASS` or a new entry:

1. **The three pushes and the two bell rows, on the Mi 9T and the iPhone 12** (G6 (a), G9): a test
   broadcaster on dev cut once (`live_cut`), cut a second time (`live_suspended`, its date), then
   withdrawn by a staff seat (`live_withdrawn`); each push arrives and opens the notifications list,
   each bell row reads its sentence and reason with no avatar of nobody
   ([lives](../services/lives.md#the-three-pushes-a-broadcaster-gets-wp-l8b)).
2. **The lift, on a dev web staff seat**: on that broadcaster's report row, "Rétablir le droit", the
   confirmation naming them, the toast, the row re-read without the withdrawal; the broadcaster's
   pre-live screen then says the suspension (still running) and no longer the withdrawal. Dev writes
   go to the harness's written-ids list.
3. **The switch hides the card**: dev's `lives_mode` closed by a global admin at `/admin/platform`,
   the feed's live card and the composer chip gone at the client's next `/api/version` read, then
   reopened ([lives](../services/lives.md#the-two-switches-live_enabled-and-lives_mode)). A dev
   write that stops every dev live: taken when no other session reads lives on dev.

**Owed by the user, not here:** the filtering statement and the terms' reread
([backlog](../backlog.md#owed-to-the-user---decisions-rotations-and-one-off-clicks), G10, G11).
