## The pause of 2026-11-07 - every pull request in flight, its last review and what it still owes

The owner paused the session on 2026-11-07 in the evening. Every agent was stopped; nothing was
left running. **Re-read each pull request's head before acting**: this list is the state at the
pause, not a measurement.

**Re-read 2026-11-12 (batch 24):** everything listed at the pause as shipped on `main` went out
in the stables from `v1.6.7` on, and #3112, #3119, #3125, #3128 and #3129 have merged; #2602 and
#2861 are closed. What is left, still drafts:

| PR | What | State at the pause | Owed |
| --- | --- | --- | --- |
| #3120 | service-to-service calls through a pinned mesh nginx | draft; review: NEEDS CHANGES (a 30 s DNS cache gap in Bun, a dead mesh that is silent) | the fix; a half-done fix was saved as a patch outside the repository |
| #3127, #3130, #3131 | dead code: knip and the translation ratchet; the first export sweep; one type factorization | drafts; review stopped before its verdict | the review (a deleted translation key still used at runtime is the P1 to rule out), then the remaining ~430 exports in batches |
| #3082 | the forms capability audit | draft | unchanged |
| #2515, #2619, #2844 | older drafts | unchanged | unchanged |

Delete this file once every row above has merged or been re-recorded where it belongs.
