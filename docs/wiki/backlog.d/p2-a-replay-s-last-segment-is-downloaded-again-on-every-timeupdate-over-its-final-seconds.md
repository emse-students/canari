## P2 - a replay's LAST segment is downloaded again on every `timeupdate` for the final ~12 seconds, and `end of stream declared` is logged each time (S13, 2026-11-20)

target: 1.7.1

**Seen on `1.7.1-alpha.5` (dev), desktop Chrome, on two of the four replays played from 0 to their end**
([S13](../device-verification.md#the-readings-of-2026-11-20-s13-171-alpha5-replays-sound-under-15-fps-messages-and-the-iphone)):

| Replay | Segments | Last segment | Requests for it | Log |
| --- | --- | --- | --- | --- |
| web live, 80 s "Je reviens" scene, no hole | 89 | index 88, 21 500 B | **46** in 12 s | 46 x `end of stream declared at 89 segments` |
| Mi 9T live, 53.3 s background pause (hole 47.87-101.16 s) | 61 | index 60, 32 738 B sealed | **46** in 12 s | 46 x `end of stream declared at 61 segments` |
| web live, plain 3 min | 94 | - | 1 (and 3 at most after my seeks) | 2 lines |
| web live, camera and mic off 80 s | 82 | index 81, 19 011 B | 1 | 2 lines |

Every other segment of every replay was requested exactly once, the one after the hole included
(index 30: once). The repeats begin when the playhead is about 12 s from the end, run at the
`timeupdate` cadence (about 265 ms, so 46 in 12 s), each is a full `GET /api/media/public/live/<id>/<segment>`
followed by `[LiveCrypto] open` of the same index and a fresh `end of stream declared`: the
`declareEnd` of [live-replays](../live-replays.md#a-replay-reaches-its-end-the-engines-state-is-the-memory-of-ended-2026-11-19)
finds the source reopened after the trim and, on the replays above, the last segment is no longer in
the buffer, so the fill takes it again. `ended` still fires and the picture plays to the last frame, so
nothing is visible to the viewer: the cost is 46 downloads of one small segment per replay watched to
its end, and a log line a reader learns to skip.

**What is NOT known**: why two replays do it and two do not (sizes are not the discriminator; the
short last segment is common to all four). **Test first**: the fake buffer of
`keeps the stream ended when the trim behind the playhead reopened it` with the LAST segment short
and the playhead 12 s away, counting `take` calls per index; it must be 1. A count, never a clock.
