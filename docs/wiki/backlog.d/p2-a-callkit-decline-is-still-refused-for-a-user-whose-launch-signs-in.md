## P2 - A CallKit Decline is still refused for a user whose launch signs in by itself (review of #2782, 2026-10-31)

#2782 stops the heartbeat holding the foreground guard at the PIN gate. A launch that signs in
WITHOUT the PIN still loads a manager in the background, and that page holds the guard, correctly:
biometrics with no prompt due (`ChatBackgroundService.svelte`, `biometricLogin(..., { unattended:
!promptDue })`), or "stay signed in" on a hardware-held key (`sessionAuth.ts`, `[PIN] Stay signed in on
a hardware-held key`). Its Decline is then refused (`encryptQueuedMessages: ok=false (... foreground
active ...)`) and the caller rings out. The fix is to send the decline THROUGH the page's loaded
manager when one exists, not a second background writer. Named in
[calls](../frontend/modules/calls.md#the-iphones-answer-never-joined-and-its-decline-never-left-152-alpha2-2026-10-31).
