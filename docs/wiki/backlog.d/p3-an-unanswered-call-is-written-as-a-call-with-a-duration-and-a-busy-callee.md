## P3 - An unanswered call is written as a call with a duration, and a busy callee leaves its caller ringing (CALL-WEB, 2026-10-26)

target: 1.9.0

**BUILT 2026-10-27 (draft PR): see [calls](../frontend/modules/calls.md#the-call-record-one-writer-a-typed-reason-2026-10-27); owed the web-row readings.**

- **P3 left: render a call row from `callEvent.outcome` and `starterId`** instead of the text baked per side at write time, so a locale change or a second device reads the same row in its own words.

**These block the `calls_mode` flip, not the stable** (B15 and B16 in
[calls](../frontend/modules/calls.md#the-blockers-each-with-its-evidence)). They are user-visible as soon
as calls are on. Read on web (W2 calling W4, `1.4.1-alpha.6`).

- **An unanswered call is written as a call with a duration.** The calls never answered were the
  cancelled one (CALL-WEB-5), the declined one (-4), the unreachable one (-6, which ends at the
  server's 60 s window) and the busy one (-7). All of them read "X a démarré un appel qui a duré moins
  d'une minute" (or "1 minute"), and the caller sees "Appel terminé · 00:00".
  - Cause, in `frontend/src/lib/utils/chat/callSystemMessages.ts`:
    - `handleCallSignalForChat` writes a rung invite with `recordCallStarted`.
    - Every later hang-up goes through `recordCallEnded`, which writes the duration.
    - `chat_system_call_missed` is written only for an invite that will NOT ring (the permission is
      off or calls are unavailable).
  - The fix needs a fact the signal does not carry today: whether the call was ever answered. The
    `answered` signal exists and is ignored here.
- **A busy callee gives the second caller nothing** (CALL-WEB-7). W5 called W4 while W4 was in a call
  with W2.
  - `CallService` does not ring a second invite over a call in progress. That is by design
    (`BUSY: ... nothing is sent for it`).
  - So W5 rang for the whole 60 s window and then ended. The call in progress kept flowing, which is
    correct.
  - Owed: an answer to the second caller (busy, or not answered at once), and the callee's missed
    call.

**Plan (batch 14, 2026-11-12) - the readings moved, one piece left.** The CALL-WEB-4..7 web rows are a row of [the readings owed](../plan.md#readings-owed). Left: render a call row from `callEvent.outcome` and `starterId` in the bubble that draws it, through Paraglide, instead of the text `recordCallEnded` bakes per side; the stored text stays as the fallback for rows written before `callEvent` existed. Client only, one renderer and its test per outcome; no agent needed.
