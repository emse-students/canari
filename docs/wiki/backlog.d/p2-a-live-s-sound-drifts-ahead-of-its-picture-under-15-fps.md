## P2 - a live's sound drifts ahead of its picture under 15 fps: fixed in the viewer, owed one reading

target: 1.7.1

Chromium's recorder writes a fragment's last video frame as 1/30 s; under 15 fps MSE reads every
fragment boundary as a discontinuity and the audio gains ~23 ms a second. The viewer now gives that
frame the interval before it, on every append, live and replay
([live](../frontend/modules/live.md#audio-drifts-ahead-of-the-video-under-15-fps-2026-11-19)).
**Owed, one reading**: the Mi 9T broadcasting for 5+ minutes in a dark room (so its camera drops
under 15 fps), watched in desktop Chrome at the edge. **In sync at the end is the test**; the
viewer's summary line counting `last frames held` only shows the rule acting (it counts the holds
that more than double the written duration).

**S12 (2026-11-19, `1.7.1-alpha.4`):** read for 6 min on the Mi at the stream level (audio ahead of video by 27 ms at the start and 28.6 ms at the end), but the camera held 29.9 fps and `0 last frames held`, so the under-15 fps path never ran. The reading stays owed with a starved camera ([S12](../device-verification.md#the-readings-of-2026-11-19-s12-171-alpha4-replays-texts-live-sound-and-the-controls)).
