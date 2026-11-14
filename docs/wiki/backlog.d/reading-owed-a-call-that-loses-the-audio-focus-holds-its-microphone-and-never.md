## Reading owed - a call that loses the audio focus holds its microphone and never hangs up: the member's own mute comes back with the...

target: 1.7.0

**What is built:** a call that loses the audio focus holds its microphone and never hangs up: the member's own mute comes back with the focus (D056, decided 2026-11-12; [calls](../frontend/modules/calls.md#a-call-behaves-like-a-phone-call-2026-10-30-after-the-owners-first-production-call), `CallFocusHold.kt`, `CallService.onAudioFocus`)

**The reading that closes it:** on the Mi 9T on a pre-release: ring its SIM during a Canari call with the iPhone - the iPhone shows the microphone cut, the Mi 9T its banner, `focus`/`lost` then `gained` in the app log; once unmuted and once muted before the ring, the second comes back muted; the call is never ended
