## P2 - a call started while another call holds the audio focus runs with a live microphone (review of #3395, 2026-11-12)

**Found by the second review of #3395 (D056); the defect is older than that PR.** `CallAudio.open`
in `CallForegroundService.kt` asks for the audio focus once, when the service starts. If Android
refuses it, for example because a cellular call is already in progress, the refusal is only logged
(`audio focus NOT granted`), and the Canari call then runs with its microphone live.

D056 holds the microphone when the focus is LOST during a call (`CallFocusHold`). A focus that was
never granted is not covered: no `LOSS` ever arrives, so nothing holds the microphone. The member is
then heard by the peer under the phone call, which is the situation D056 was decided against.

**The fix, not built:** a refused request at `open()` must hold the microphone exactly like a
permanent `LOSS`. That means `CallFocusHold` starts held, the service emits `focus`/`lost`, and the
existing ask paths release it later: a mute control's tap and the app returning to the screen. The
release is a grant, so it rests on no timer. Tests are needed on both sides: the Kotlin hold starting
held, and the page receiving `lost` before any GAIN.

**A reading on the bench phone after it ships:** start a Canari call while a cellular call is in
progress. The microphone must be held, and must come back after the cellular call ends and a mute tap.

Mechanism: [calls](../frontend/modules/calls.md#a-call-behaves-like-a-phone-call-2026-10-30-after-the-owners-first-production-call).
