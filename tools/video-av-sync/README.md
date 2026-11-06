# video-av-sync - does a prepared video keep its picture on its sound?

A headless Chrome makes a 14 s source with a KNOWN sync (a white frame and a 1 kHz beep on every
whole second), runs it through the app's own `prepareVideoForUpload` (imported from
`frontend/src/lib/video/`, built from source), reads the output back through mediabunny's sinks and
judges it: every flash within one output frame of its beep, the first AND the last; every frame on
the constant 30 fps grid; video and audio ending together. Built 2026-11-06 for a production post
whose sound no longer matched its picture at the end; the readings and what they prove are in
[video-preparation](../../docs/wiki/frontend/video-preparation.md#constant-frame-rate).

```sh
bun test tools/video-av-sync                       # the arithmetic (no browser), in make test-ci-scripts
bun tools/video-av-sync/rig.mjs                    # every row, ~1 min
bun tools/video-av-sync/rig.mjs --only vfr-aac-96 --chrome <path>
```

The rows (`CASES` in `rig.mjs`): a phone that drops frames (holes of a quarter second, frames
jittered, flashes off the grid) with AAC re-encoded, AAC copied, and VP8 + Opus in WebM (the Android
recorder's shape); a 60 fps and a 24 fps clip. The exit code fails on a failed verdict or a row that
does not complete.

**It needs an engine with an AAC encoder** to make its sources: Chrome on Windows or macOS. Chrome
on Linux has none, which is why no CI job runs it yet.
