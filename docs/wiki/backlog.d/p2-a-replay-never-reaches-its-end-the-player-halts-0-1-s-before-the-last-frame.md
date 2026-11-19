## P2 - a replay never reaches its end: the player halts about 0.1 s before the last frame, a spinner for good (read 2026-11-19, S12)

target: 1.7.1

Read on dev in sitting [S12](../device-verification.md#the-readings-of-2026-11-19-s12-171-alpha4-replays-texts-live-sound-and-the-controls), on `1.7.1-alpha.4`, desktop
Chrome, in the CanaReels viewer. **Two of two replays played to the end and stopped there**: the live
with a flip and a 17.6 s pause (a58bea76, 82.7 s of media) and a continuous 54 s live with neither
(61 s of media). Both: `currentTime` stops at `duration - 0.12 s` (82.607 of 82.729; 60.560 of
60.671), `readyState` 2, `ended` false, the `waiting` event fired once, and the spinner turned for the
3+ minutes observed. With the viewer's `loop` on it never loops either. The log says
`[LIVE_REPLAY] ...: end of stream declared at 34 segments` BEFORE the stall, so the source was closed
correctly.

What the `<video>` showed after the end of stream: `buffered` ended at 82.7099 while `duration` read
82.7294, a 0.02 s tail the buffer does not hold, and the playhead sat 0.1 s before the buffer's end. The
likely cause is the two tracks ending 20 ms apart (the audio's last sample ends after the video's last
frame, so `duration` is the audio's end and the intersection `buffered` is the video's): a playhead
cannot enter a range tail shorter than the engine's minimum, and with the end declared nothing waits for
more data. Read in the numbers, not yet proven by a fix.

Not the defect already known for pauses longer than about 48 s (positionAhead re-fetching the segment
after the hole): these replays have no such pause (the longest hole is 17.6 s) and the console capture of the
first play-through shows one segment (14, at the 0.8 s flip) opened twice and no other refetch.

Closes when: a replay played from 0 to its end with no touch ends (`ended` fires, the viewer loops or
shows its end state, no spinner), on desktop Chrome and on both phones, and a unit test feeds
`ReplayPlayer` a buffer whose video ends 20 ms before its audio and asserts the playhead reaches the end.
The test that was missing: every segment fixture ends both tracks on the same instant.
