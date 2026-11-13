## P3 - At boot the web client sends 10 `GET /api/users/batch` and 10 `GET /api/users/avatar-presence` in the same millisecond (owner's Firefox console, production 1.6.8, 2026-11-09)

target: 1.10.0

Both are already coalesced, but only within ONE microtask turn: `enqueueProfileFetch`
(`frontend/src/lib/stores/user.ts`, `queueMicrotask`) and `avatarPhotoPresence`
(`frontend/src/lib/utils/avatarPresence.ts`, `queueMicrotask`). Ten pairs in one millisecond means ten
surfaces each asking in its own task, so each opens its own batch. The ids differ per surface, so a
join on an in-flight request does not help.

Candidate, not applied because the actual spread of the ten asks was not read from a trace: widen the
window from a microtask to ONE MACROTASK (`setTimeout(0)` or a `MessageChannel` post) in both
coalescers, exactly as the comments there already justify a window ("a window, not a clock"). It costs
at most a few ms of latency and turns a same-millisecond burst of tasks into one pair; a burst spread
over 450 ms (the 2026-09-15 trace in the `stores/user.ts` comment) stays several requests. Measure the
request count of a cold boot before and after.
