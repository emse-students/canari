## P3 - A call that loses the audio focus goes on as if nothing happened (decision owed, 2026-10-30)

Since #2723 the Android call takes the audio focus (`AUDIOFOCUS_GAIN_TRANSIENT`, voice communication) and LOGS every change (`audio focus LOSS_TRANSIENT for call=...`). Nothing acts on a loss: a cellular call ringing in, or another app taking the focus, leaves the Canari call's microphone and voice running under it. Whether to HOLD the call (mute both ways and say so) or auto-mute the microphone on `LOSS_TRANSIENT`, and what `LOSS` means, is the owner's product decision; the logs from the phone readings say how often it happens ([calls](../frontend/modules/calls.md#a-call-behaves-like-a-phone-call-2026-10-30-after-the-owners-first-production-call)). Delete with its decision.

**Recommendation (batch 17, 2026-11-12), for the lead to take under the absence rule - reversible, a
behaviour behind no data change.** On `LOSS_TRANSIENT` (a cellular call ringing in, a navigation
prompt): MUTE the microphone and say so on the call screen and to the peer ("en pause - appel
téléphonique"), and restore the member's own mute state on `GAIN` - a phone call's behaviour, and the
peer is never left talking to a muted line without knowing. On `LOSS` (another app took the focus for
good): the same hold, never a hang-up - only the member ends a call. `LOSS_TRANSIENT_CAN_DUCK` changes
nothing. **Brief once taken (Sonnet with a native review, one PR born `--draft`):** the focus listener
of #2723 (`CallForegroundService.kt`, `focusListener`, where it logs today) forwards the change through the existing call
plugin event to `CallService`, which holds and restores; the peer is told through the call's signalling
channel the existing mute uses; tests: a JVM test of the focus mapping, and a `CallService` test that
a transient loss mutes and a gain restores the member's own state (muted before stays muted). One Mi
9T reading: a cellular call into a Canari call.
