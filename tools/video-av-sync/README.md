# video-av-sync - does a prepared video keep its picture on its sound?

A headless Chrome makes a 14 s source with a KNOWN sync (a white frame and a 1 kHz beep on every
whole second), runs it through the app's own `prepareVideoForUpload` (imported from
`frontend/src/lib/video/`, built from source), reads the output back through mediabunny's sinks and
judges it: every flash within one output frame of its beep, the first AND the last; every frame on
the constant 30 fps grid; no hole in the audio; video and audio ending together. Built 2026-11-06 for a production post
whose sound no longer matched its picture at the end; the readings and what they prove are in
[video-preparation](../../docs/wiki/frontend/video-preparation.md#constant-frame-rate-and-the-audio-holes-the-decoder-closes).

```sh
bun test tools/video-av-sync                       # the arithmetic (no browser), in make test-ci-scripts
bun tools/video-av-sync/rig.mjs                    # every row, ~1 min
bun tools/video-av-sync/rig.mjs --only vfr-aac-96 --chrome <path>
```

The rows (`CASES` in `rig.mjs`): a phone that drops frames (holes of a quarter second, frames
jittered, flashes off the grid) with AAC re-encoded, AAC copied, and VP8 + Opus in WebM (the Android
recorder's shape); the same with 7 holes of 213 ms in its AAC track (a recorder that lost audio
buffers); a 60 fps and a 24 fps clip. The output's audio is read at its PACKETS' times - Chrome's
decoder closes holes, so a reading through it would hide the drift - and a hole left in the output
fails the row. The exit code fails on a failed verdict or a row that
does not complete.

**It needs an engine with an AAC encoder** to make its sources: Chrome on Windows or macOS. Chrome
on Linux has none, which is why no CI job runs it yet.
