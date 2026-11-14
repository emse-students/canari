## P2 - A CallKit Decline is still refused for a user whose launch signs in by itself (review of #2782, 2026-10-31)

target: 1.10.0

#2782 stops the heartbeat holding the foreground guard at the PIN gate. A launch that signs in
WITHOUT the PIN still loads a manager in the background, and that page holds the guard, correctly:
biometrics with no prompt due (`ChatBackgroundService.svelte`, `biometricLogin(..., { unattended:
!promptDue })`), or "stay signed in" on a hardware-held key (`sessionAuth.ts`, `[PIN] Stay signed in on
a hardware-held key`). Its Decline is then refused (`encryptQueuedMessages: ok=false (... foreground
active ...)`) and the caller rings out. The fix is to send the decline THROUGH the page's loaded
manager when one exists, not a second background writer. Named in
[calls](../frontend/modules/calls.md#the-iphones-answer-never-joined-and-its-decline-never-left-152-alpha2-2026-10-31).

**Agent brief (batch 18, 2026-11-12; native iOS, Opus).** Still open: the CallKit End handler
(`performEndCallAction`, `canari_push.mm`) always sends through `CanariSendCallDecline`, the background
writer, and the guard a loaded manager holds refuses it. Goal: when the page holds a loaded manager,
the decline is sent BY THE PAGE (the in-app Decline's hangup, `CallService`), and the background
writer is used only when no manager is loaded - a fact the native side already has (the guard), never
learned from the refusal. Start: `canari_push.mm` (`CanariSendCallDecline`, the End handler, the
held-answer handover `CanariTellPageOfPendingCallAccept` for the shape of a page hand-off),
`ios_ffi.rs` (the hangup builder), `concurrency.rs` (the foreground guard), and the page's ring
handling in `CallService.ts`. Proof: a Rust or page test that a decline with a loaded manager goes
through the page and one with none goes native; one iPhone 12 reading with biometrics and one with
"stay signed in" (the caller's ring ends at once, `declined` on its record). Not before the Answer
path's own limitation (a page mounting between Answer and activation) is re-read: one hand-off
mechanism for both.
