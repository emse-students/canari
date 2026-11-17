## P3 - a member whose right to broadcast is given back is not told

target: 1.7.0

Found by the review of #3772 (2026-11-17). A withdrawal is told (`live_withdrawn`: a bell row and a
push), but its lift (`DELETE /api/lives/broadcasters/:userId/withdrawal`, `liftWithdrawal` in
`lives.service.ts`) writes no notice: the member learns it only by opening the pre-live screen, which
reads the standing again. Charter: principle 6 (kindness) - a sanction lifted deserves the same
voice as the sanction.

**The fix, about a day:** a `live_reinstated` notice written by `liftWithdrawal` when `lifted` is true
(no actor, as the other three), registered where `live_withdrawn` is (`bell-row-gates.ts`,
`engagement-push-cap.ts`, `notification-category.ts`, `notification-client-floor.ts` with the
version that first draws it, the push strings), and its bell row in `NotificationRow` with
`notif_live_reinstated_text` in fr and en; a running suspension is not lifted with it, so the
sentence says only that lives may be started again once any suspension ends. Tests: the notice in
the lives service spec, the row in `NotificationRow.svelte.test.ts`.
