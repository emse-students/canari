## P3 - `[Call] voice did not start` is logged when a pause interrupted the play (1.8.2 log, 2026-11-27)

target: 1.8.4

`callVoice.ts` logs `[Call] voice did not start (stream arrived): AbortError: The play() request was
interrupted by a call to pause()` - the same shape as the feed's `playWhileVisible` AbortError fixed
in 1.8.4 (a pause aborted a pending `play()`; by the time the rejection landed a newer play, or the
decision that paused it, had already settled the element). Classify at the throw from the element's
facts (paused, a newer play asked, source changed) as `isExpectedPlayInterruption` does, and keep the
line only for an AbortError nothing explains. Not touched in the noise batch: the call-screen and
call-join code belongs to another work stream.
