## P2 - a live's sound drifts ahead of its picture under 15 fps: fixed in the viewer, owed one reading

target: 1.7.1

Chromium's recorder writes a fragment's last video frame as 1/30 s; under 15 fps MSE reads every
fragment boundary as a discontinuity and the audio gains ~23 ms a second. The viewer now gives that
frame the interval before it, on every append, live and replay
([live](../frontend/modules/live.md#audio-drifts-ahead-of-the-video-under-15-fps-2026-11-19)).
**Owed, one reading**: the Mi 9T broadcasting for 5+ minutes in a dark room (so its camera drops
under 15 fps), watched in desktop Chrome at the edge: in sync at the end, and the viewer's summary
line counting `last frames held`.
