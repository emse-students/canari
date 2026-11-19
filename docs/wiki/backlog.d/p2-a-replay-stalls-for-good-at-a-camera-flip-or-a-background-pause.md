## P2 - a replay stalls for good at the first camera flip or background pause of its live (read 2026-11-19, S11)

target: 1.7.1

Read on dev in sitting [S11](../device-verification.md#the-phone-readings-of-2026-11-19-s11-171-alpha3-live-replays-on-dev),
on the Mi 9T and the iPhone 12, and **live in production since the switch of 2026-11-19**. A live that
flipped its camera once and went to the background for 20 s was replayed from the CanaReels viewer: the
picture froze at about 16 s and the spinner turned until the viewer was closed (95 s observed on the Mi,
minutes on the iPhone). A replay of a live that never flipped or paused plays and seeks (Mi: 10 s to 67 s
of 70.7 s, a seek into unbuffered media resumed in about a second).

What the Mi's `<video>` showed (polled once a second over CDP): the buffered ranges were
`[0, 16.6] [17.4, 27.6] [45.2, 76.1]`: a 0.8 s hole where the camera flipped (a new generation, a new init)
and a 17.6 s hole where the app was in the background (the live's own pause). The playhead stopped at
16.07 s (`readyState` 2, then 1), 0.5 s before the first hole, and never moved. A seek past the holes, into a
buffered range, played on to the end of the range; a seek INTO a hole stalled again. The engine's `waiting`
event reaches `ReplayPlayer.noteStall`, which returns early while the playhead is inside a buffered range
(`at < e - 0.05`): a stop 0.5 s before the edge looks like the engine's own wait, so nothing re-anchors. That
is the likely cause (read in the code, not yet proven by a fix). Mechanism and the player's design:
[live-replays](../live-replays.md), `frontend/src/lib/live/replayPlayer.ts`.

Closes when: a replay with a camera flip and a background pause, on both phones, plays through both
boundaries with no touch, and a unit test feeds `ReplayPlayer` a buffered set with a 0.8 s hole and one with
a 17 s hole and asserts the playhead is moved past each (the test that was missing, since every segment
fixture was contiguous).

### Found in the same reading, not blockers

- **The card's length is short by about 6 s.** `durationMs` is taken from the FIRST segment's arrival to the
  last, and the first three segments arrive in one burst (0 s, 0.6 s, 1 s) after the recorder's start-up, so the
  media they hold is not counted: 64.6 s on the card against 70.7 s of media on the Mi, 77.2 s against 82.7 s
  for the flip-and-pause live. The progress line's total therefore jumps during play. Derive it from the
  media (`atMs` of the last segment plus its length), not from arrival times.
- **A saved replay is indexed by MediaStore at about 2 s.** The Gallery plays the whole fragmented MP4 (it showed
  `01:00` over a `00:02` total), but the listed length and the seek bar are wrong. Write a moov duration, or
  remux the saved part, so that the gallery's index agrees with the file.
