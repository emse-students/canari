## The pause of 2026-11-07 - every pull request in flight, its last review and what it still owes

The owner paused the session on 2026-11-07 in the evening. Every agent was stopped; nothing was
left running. **Re-read each pull request's head before acting**: this list is the state at the
pause, not a measurement.

**Shipped since `v1.6.6`, on `main`, not yet in a release**: #3102, #3103, #3105, #3106, #3107,
#3109, #3114, #3115 (WP-D2), #3116, #3117, #3121, #3123, #3126, #2832, #3024 (migration 134, held,
approved). `v1.6.7-alpha.1` is on dev. **Next: `v1.6.7-alpha.2`** once #3112 merges and `main`'s
`CI passed` is green on the head, then the readings on dev and both phones (grid table, criterion
confirm, order bar, mentions, Formulaires; salon open on the Mi 9T and the iPhone fling; push key
labels; D2 with test parents on dev; the share sheet over a live; the live chat and the arrival
lines), then the stable.

| PR | What | State at the pause | Owed |
| --- | --- | --- | --- |
| #3112 | content-free push, the envelope (switch off) | armed; a contract test fixed (it now reads `isInternalSilent`) | merge on green |
| #3119 | an association's live notifies everyone who can see it; the engagement design (`docs/wiki/engagement.md`, on that branch) | draft; re-review: NEEDS CHANGES | the CGU line (still "followers"); **WP-1b (one announced live per association per 6 h) built IN this PR**; an archived association may not go live; two stale sentences; the held-migration order for WP-3/WP-4. A half-done fix was saved as a patch outside the repository |
| #3120 | service-to-service calls through a pinned mesh nginx | draft; review: NEEDS CHANGES (a 30 s DNS cache gap in Bun, a dead mesh that is silent) | the fix; a half-done fix was saved as a patch outside the repository |
| #3125 | the Dependencies panel reads at a glance | draft; every finding fixed (`ede8c08e6`) | one re-review, then arm |
| #3128 | controls: one box, three mandatory components, a ratchet guard | draft; review: NEEDS CHANGES | `min-height` (Android 200 % text), ten compact field Pickers back to 40 px, the textarea edge, danger contrast, the PIN footer height, the guard's bypasses. A half-done fix was saved as a patch outside the repository |
| #3129 | controls batch 2 (stacked on #3128) | draft; review: NEEDS CHANGES | **P1**: revert the four message-action tiles (`MessageMobileActions.svelte`); a `danger-outline` variant for ~17 destructive buttons flattened to grey; one primary per view |
| #3127, #3130, #3131 | dead code: knip and the translation ratchet; the first export sweep; one type factorization | drafts; review stopped before its verdict | the review (a deleted translation key still used at runtime is the P1 to rule out), then the remaining ~430 exports in batches |
| #3082 | the forms capability audit | draft | unchanged |
| #2515, #2602, #2619, #2844, #2861 | older drafts | unchanged | unchanged |

Also new on 2026-11-07: [live replays](live-replays-kept-three-days-as-canareels.md), decided, not
designed. **Questions for the owner at the restart**: the CanaReel model questions that the replay
design and its audit will raise; none other is pending.

Delete this file once every row above has merged or been re-recorded where it belongs.
