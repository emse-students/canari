# Video preparation: the phone compresses, the server stores (CanaReels R2, decision C3)

**Every video leaves the device as ONE format, made ON the device**: a fragmented MP4, H.264 + AAC,
720p on its short side at ~2.5 Mb/s, a CONSTANT 30 fps ([why](#constant-frame-rate-and-the-audio-holes-the-decoder-closes)), rotation baked into the frames, in a `File`
whose `type` names its codecs. The video is always re-encoded; an AAC-LC audio track is COPIED
when it has no hole and costs no more than an encode would, or when the engine has no AAC encoder ([why](#an-aac-lc-track-is-copied-and-a-firefox-avcc-is-rebuilt-2026-10-14)). The server transcodes nothing and draws no thumbnail - the user's
decision C3, 2026-09-29 (*"il faut que la charge serveur soit minimale"*), recorded on
[backlog](../backlog.md#the-composer-and-canareels-chantier---compared-on-the-mi-9t-2026-09-29-every-decision-taken).

## The seam - `prepareVideoForUpload` (`frontend/src/lib/video/prepareVideoForUpload.ts`)

```ts
prepareVideoForUpload(source: Blob, {
  maxSeconds?: number,          // 90 for a CanaReel (C4); omitted = only the byte budget bounds it
  maxBytes?: number,            // MediaService.uploadLimits().maxPlaintextBytes
  removeAudio?: boolean,        // the member removed the sound: no audio track at all
  trimToVideo?: boolean,        // a reel: cut to the video track's own span (videoSpanTrim), see reels.md
  onProgress?: (fraction) => void,  // 0..1 as frames are encoded
  signal?: AbortSignal,         // cancel
}): Promise<PreparedVideo>      // { file, width, height, durationSeconds, sourceBytes, outputBytes }
```

- **Any source**: Android's `MediaRecorder` WebM (H.264, else VP8/VP9, + Opus), iOS's MP4/MOV (H.264 or HEVC +
  AAC), a gallery file of either. A caller passes the recorder's `Blob` or the picked `File` as is.
- **What comes back is what is uploaded**: hand `file` to `MediaService.encryptAndUpload`, and
  `width`/`height` to it as the dimensions (the rotation is already applied).
- **Every failure is a `VideoPrepareError` with a `fault`** - the UI maps it to a Paraglide sentence
  and never reads the message:

| `fault` | Means | What the caller does |
| --- | --- | --- |
| `aborted` | the caller's `signal` fired | nothing - not a failure, logged at debug |
| `unreadable` | no container this engine reads, or no frame size | tell the member the file cannot be read |
| `no-video-track` | a container with no video in it | same |
| `too-long` | over `maxSeconds` (+0.5 s grace for the recorder's last frame), or too long for the ceiling even at 400 kb/s | say how long a video may be |
| `unsupported` | this engine cannot decode the source, encode H.264, or encode AAC for a source whose audio is NOT AAC-LC - read as a FACT from the conversion's discarded tracks, before a frame is touched | say this device cannot prepare it |
| `encode` | the encoder or the muxer failed mid-way | offer to try again |
| `too-large` | the output came out over `maxBytes` despite the plan | same as `too-long` |

**There is no second path.** An engine that cannot make the format is refused, never handed the
original to upload: an untranscoded upload is a second format every reader then carries for ever,
and the exact server cost C3 refused.

## The numbers (`videoEncodingPlan.ts`, the only copy)

| | Value | Why |
| --- | --- | --- |
| Short side | 720 px, never scaled up | C3's 720p, whichever way the phone was held |
| Video bitrate | 2.5 Mb/s, LOWERED to fit `maxBytes` over the duration, floor 400 kb/s | C3: ~28 MB for 90 s; a longer video fits by losing bitrate, not by being cut |
| Budget share | 90 % of `maxBytes` asked of the encoder | the fragments' boxes and a variable-rate encoder's overshoot |
| Audio | AAC, 128 kb/s; an AAC-LC (`mp4a.40.2`) source at most 128 kb/s, or on an engine with no AAC encoder, is COPIED and budgeted at its measured bitrate | a copy loses nothing; a dearer track is re-encoded where it can be, so a long clip's video keeps its budget |
| Frame rate | a CONSTANT 30 (`VIDEO_FRAME_RATE`), every source resampled onto the grid | the Canari camera's rate; a 60 fps clip costs twice for no reader, and a variable-rate one hands every player [timestamps to interpret](#constant-frame-rate-and-the-audio-holes-the-decoder-closes) |
| Key frames | every 2 s | every fragment starts on one: the seek granularity |

## Why WebCodecs + mediabunny, and not the alternatives

Measured on both phones on 2026-10-01 inside the app's own WebView (`VideoEncoder.isConfigSupported`
and friends, over the rig's CDP / WebKit-inspector bridges):

| | Mi 9T (Android 16, WebView 152) | iPhone 12 (iOS 27, WKWebView) |
| --- | --- | --- |
| `VideoEncoder` H.264 720p 2.5 Mb/s (hardware) | yes | yes |
| `AudioEncoder` AAC / Opus | yes / yes | yes / yes |
| `VideoDecoder` H.264, VP8, VP9, HEVC | all | all |
| `MediaRecorder` writes | WebM (VP8/VP9 + Opus) only | MP4 (H.264 + AAC) and WebM |
| MSE | `MediaSource` | `ManagedMediaSource` |

- **WebCodecs** gives hardware decode and encode on both engines with the same code. **mediabunny**
  (MPL-2.0, pure TypeScript, loaded on demand - ~0.7 MB minified, only paid by a member who picks a
  video) demuxes every source container and muxes the fragmented MP4.
- **A `MediaRecorder` re-encode** (play the source into a canvas and record it) runs in real time at
  best, cannot write MP4 on Android at all, and records whatever the screen pipeline drops.
- **A native path** (Media3 Transformer, `AVAssetExportSession`) would be two implementations in two
  languages for a result the WebView already reaches, and none for the web.
- **ffmpeg.wasm** is software-only: minutes for a 90 s clip on a phone.

## What the device readings say (2026-10-01)

The seam injected into the installed app's WebView over the rig's bridges, a clip pushed in, the
output played, sought, appended whole to MSE and pulled back for `ffprobe`. Synthetic sources made
with ffmpeg to stand for the two recorders: a 20 s 1280x720 VP8 + Opus WebM (Android's recorder), a
20 s 1920x1080 HEVC 60 fps MOV with a 90-degree display matrix (an iPhone portrait clip).

| Source -> phone | Took | Output | Plays / seeks | MSE (`isTypeSupported`, appended) |
| --- | --- | --- | --- | --- |
| VP8 WebM 6.6 MB -> Mi 9T | 8.1 s | 7.7 MB, 1280x720, H.264 High 2.97 Mb/s + AAC 128 kb/s, 30 fps | yes / to 10.03 s | yes, 8 x 1 MiB, buffered 0-20.05 s |
| HEVC MOV 30.9 MB -> Mi 9T | 13.8 s | 7.8 MB, 720x1280 (rotation baked), 30 fps | yes / yes | yes, buffered 0-20.03 s |
| HEVC MOV 30.9 MB -> iPhone 12 | 28.4 s | 6.0 MB, 720x1280, H.264 High 2.38 Mb/s, 30 fps | yes / to 10.02 s | yes, 6 appends, buffered 0-20.07 s |
| VP8 WebM 6.6 MB -> iPhone 12 | 1.9 s | 3.4 MB, 1280x720 | yes / yes | yes |

Every output's `type` was `video/mp4; codecs="avc1.64001f, mp4a.40.2"`. Progress arrived ~600-1200
times per run, first at 0, last at 1. The Mi 9T's encoder OVERSHOOTS the asked bitrate by ~19 % on
synthetic test patterns (2.97 against 2.5 Mb/s); at that rate a 90 s reel is ~35 MB, still under the
50 MB ceiling, and `too-large` is what holds the line if a source ever beats the budget share.

**Real camera clips, recorded on each phone's own camera app** (a dark scene, which is why they
come out small - the bitrate is VARIABLE and black costs nothing; the synthetic rows above are the
bitrate measurement): Mi 9T, 24.5 s H.264 Baseline 1080p, rotation -90, 7.0 MB; iPhone 12, 25.5 s
HEVC Main 10 (HDR) 1920x1080, rotation -90, plus Apple's metadata tracks, 30.7 MB.

| Source -> phone | Took | Output | Plays / seeks | MSE |
| --- | --- | --- | --- | --- |
| iPhone clip -> iPhone 12 | 15.7 s | 2.7 MB, 720x1280, 25.47 s | yes / to 12.7 s | 3 appends, buffered 0.02-25.53 s |
| Mi 9T clip -> iPhone 12 | 19.1 s | 0.67 MB, 720x1280, 24.51 s | yes / to 12.3 s | buffered 0.02-24.57 s |
| iPhone clip -> Mi 9T | 17.1 s | 0.66 MB, 720x1280, 25.47 s | yes / to 12.7 s | buffered 0-25.49 s |
| Mi 9T clip -> Mi 9T | 12.6 s | 0.53 MB, 720x1280, 24.51 s | yes / to 12.3 s | buffered 0-24.53 s |
| iPhone clip -> Mi 9T, aborted at 30 % | 5.1 s | `VideoPrepareError` `aborted` | - | - |

Apple's metadata tracks are discarded without a refusal; the HDR source is tone-mapped to 8-bit
H.264 by the decoder, and its COLOURS have not been compared by eye.

### In the app, with the writer ON (bench build, 2026-10-02)

The composer wiring on an APK and an iOS build carrying `SEGMENTED_MEDIA_WRITER_ENABLED = true`
(never merged), against the local estate, the clip handed to the composer's own file input:

- **Post composer, both phones**: the progress line counts 0 -> 100 % (~100 distinct values) while
  `[video-prep] plan: 720x1280, 2500 kb/s, 25.47 s` ... `done in 16459 ms: 30729927 -> 662654
  bytes` logs, then `[media-seg] encrypt: ... in N segment(s)`, `POST /api/media/upload 201`,
  `POST /api/posts 201`. A 7.8 MB output went up as 8 segments.
- **Streaming, both directions**: the Mi 9T's 8-segment post opened on the iPhone as eight
  `GET /api/media/:id` -> `206` (`1048612`, six `1048592`, `436748` bytes), and on the Mi 9T itself
  through `[media-seg] stream ... through MediaSource` -> `8 segment(s) appended`; each sought to
  15 s and played on.
- **Cancel, both phones**: the cross at 30 % logs `cancelled by the member` -> `aborted` ->
  `[POST_COMPOSER] publish stopped: video preparation cancelled`; the composer keeps its text and
  its video, no banner, Publish enabled.
- **Typed refusal, both phones**: 300 kB of random bytes named `.mp4` -> `[video-prep] refused:
  video/mp4 is no readable container`, `publish failed at mediaPrepare VideoPrepareError`, banner
  *"Cette video ne peut pas etre lue."*
- **Chat composer, both phones**: the line runs at PICK time, the file joins the pending strip
  prepared; sent segmented; the other phone and the desktop recipient read it WHOLE (`200`, chat
  bubbles do not stream - [media-service](../services/media-service.md#who-reads-it-and-how)) and
  it plays and seeks on the other phone (iPhone's 25.55 s clip on the Mi 9T, Mi 9T's 20 s on the
  iPhone).

## An AAC-LC track is copied, and a Firefox avcC is rebuilt (2026-10-14)

**The report**: a 49 s, 54.9 MB AV1 + AAC-LC (48 kHz stereo, 189 kb/s) MP4 picked in the web app on
Firefox 157 (Windows) was refused - `audio track 2: no_encodable_target_codec`, then `unsupported`.

**Cause one, ours**: the audio options were `codec: 'aac'` + a `Quality` + `forceTranscode: true`,
and EACH of the last two makes mediabunny re-encode (`_processAudioTrack`: `needsTranscode` is true
on `forceTranscode`, on `quality`, on a sample rate or channel count that differs). The encode then
filters the candidates to `aac`, and Firefox's WebCodecs has no AAC encoder
(`AudioEncoder.isConfigSupported({codec: 'mp4a.40.2'})` is `false`, Opus is `true`; Chrome 154 has
both), so no codec was left and the track was discarded. The AAC was never the problem: MP4 carries
it as is. **Fix**: `chooseAudioRoute` chooses the route from FACTS read off the source and the
engine - its codec string, its measured bitrate, and mediabunny's `canEncodeAudio('aac', ...)` probe
at the plan's settings - never from the browser's name. An `mp4a.40.2` track is COPIED (options: the
codec alone) when it costs at most `AUDIO_BITRATE` (128 kb/s), or when the engine cannot encode AAC;
it is re-encoded only when it is dearer AND an encoder exists, so a 320 kb/s track does not take
budget from a long clip's video on Chrome. Anything else is encoded to AAC as before; HE-AAC
(`mp4a.40.5`) too, because the output names AAC-LC. A copied track is budgeted at its own measured
bitrate. **This is not a fallback**: each route is a primary path chosen before any work, on facts
that decide it, and neither is reached by another one failing.

**Cause two, Firefox's, found once cause one was gone**: Firefox's H.264 encoder (Media Foundation;
its SEI says `Microsoft`) hands back an `avcC` whose SPS and PPS each carry their first byte twice
(`67 67 64 ...`, `68 68 ce ...`) with the reserved bits zeroed (`03 01` for `ff e1`), while every key
frame carries the correct SPS/PPS in-band. The file plays in Firefox, which reads the in-band sets;
Chrome loads its first frame and then fails the seek with `PIPELINE_ERROR_DECODE`, so an Android
reader would have been handed a broken video. Remuxing the SAME packets under an `avcC` built from
the in-band sets made Chrome play, seek and append it, which isolates the record. It is
[mediabunny issue 559](https://github.com/Vanilagy/mediabunny/issues/559).
**Fix, since mediabunny 1.65.0 (2026-11-03): upstream's own, and the patch is DELETED.** 1.65.0 strips the doubled first byte of the SPS and PPS itself (`media-source.js`, gated on `isFirefox()`, which reads `navigator.userAgent` once and caches it). The earlier ports (1.62.1, 1.63.0) were kept because 1.61.6's notes already claimed the workaround yet the bare test failed: the test stubbed no user agent, so the gate never opened. `mediabunnyAvcDescription.test.ts` now imports a fresh mediabunny under a Firefox user agent, replays Firefox's bytes through a fake `VideoEncoder` and asserts the `avcC` is well formed. **One difference, owed a reading:** upstream re-serialises the record it parsed, which has no High-profile extension (`fd f8 f8 00`), where our patch rebuilt one from the in-band sets; the 2026-10-14 table below was measured with the extension. Play, seek and append a Firefox-encoded file in Chrome once on Windows.

**Readings, Windows desktop, 2026-10-14** (headless Firefox 158 and Chrome 154 running the seam
itself; the member's own file and a synthetic AV1 + AAC-LC 53.8 MB, 1080p, 49 s stand-in):

| Source -> engine | Before | After | Output plays, seeks to 30 s, appends to MSE |
| --- | --- | --- | --- |
| member's file -> Firefox | `unsupported`, `no_encodable_target_codec` | 17.0 s, 15.9 MB, 1280x720, `avc1.64001f, mp4a.40.2` | Chrome: yes / yes / 0-49.13 s |
| stand-in -> Firefox | same refusal | 17.1 s, 14.1 MB, audio bytes identical to the source's | Chrome and Firefox: yes / yes / yes |
| stand-in -> Chrome | 3.1 s, 17.0 MB (AAC re-encoded) | 2.8 s, 17.0 MB: 189 kb/s is dearer than 128 and Chrome has the encoder, so it is re-encoded, as before | Chrome and Firefox: yes / yes / yes |

AV1 decodes in both engines through WebCodecs (`VideoDecoder.isConfigSupported` `true`, and the
conversions above). The phones were NOT re-read: they encode AAC, so their only change is that an
AAC-LC source of at most 128 kb/s is copied rather than re-encoded.

**What stays refused on Firefox**: a source whose audio is NOT AAC-LC (an Opus WebM, say) - it still
needs an AAC encoder Firefox lacks. Writing Opus into the MP4 would be a second output format the
readers and `chooseSegmentedPlayback` would carry, which is a decision, not a fix.

## Constant frame rate, and the audio holes the decoder closes

**The report (owner, 2026-11-06), on one production feed post**: a 13.6 s 720x1280 H.264/AAC
fragmented MP4 whose picture was "really late" and whose sound no longer matched the picture at
the END. A desktop Chrome playing it showed 11 frame gaps over 60 ms in 9 s, the longest 258 ms.
**Decision**: measure, then NORMALISE - every video converted at upload to the Canari camera's
format, a constant 30 fps.

### The production file, read in the owner's browser (never named here)

`avcC` profile 100 (High), level 31; no `elst` on either track; no composition offsets; video
timescale 57600 (mediabunny's `GLOBAL_TIMESCALE`, used only for a track with NO frame rate: this
seam made the file and did not resample it), audio 48000.

| `moof` | video start s | samples | sum s | min-max ms | gaps > 66 ms | audio start s | samples | sum s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 0 | 46 | 2.0219 | 16.2-257.5 | 4 | 0.0373 | 92 | 1.9627 |
| 2 | 2.0219 | 60 | 2.0039 | 27.4-39.8 | 0 | 2.0000 | 94 | 2.0053 |
| 3 | 4.0259 | 60 | 2.0025 | 27.5-39.7 | 0 | 4.0053 | 94 | 2.0053 |
| 4 | 6.0284 | 60 | 1.9817 | 15.4-50.4 | 0 | 6.0107 | 93 | 1.984 |
| 5 | 8.0101 | 60 | 1.9992 | 16.6-50.5 | 0 | 7.9947 | 93 | 1.984 |
| 6 | 10.0094 | 60 | 2.0022 | 10.8-53.7 | 0 | 9.9787 | 94 | 2.0053 |
| 7 | 12.0116 | 36 | 1.2024 | 24.4-42.4 | 0 | 11.984 | 37 | 0.7893 |
| 8 | 13.2139 | 12 | 0.404 | - | 0 | (video only) | | |

The video ends at 13.6179 s, the audio at 12.7733 s - **0.845 s earlier**. Every audio sample lasts
exactly 1024 ticks (21.3 ms), contiguous across fragments: the audio track has no hole at all. The
video is irregular (4 stalls up to 258 ms in its first 2 s, frames 11-54 ms apart after that).
The fragment starts of the two tracks stay within ~30 ms of each other, but that only says where
the muxer cut: it interleaves the output's own timestamps, whatever those have lost.

### The cause, proven: Chrome's audio decoder closes the source's holes

A phone that drops audio buffers while recording writes an audio track with HOLES - packet n+1
starts later than packet n ends, and its timestamp says so. **Chrome's WebCodecs `AudioDecoder`
ignores that**: it stamps its first output with the first packet's time and every later output
with the frames decoded so far. Measured 2026-11-06 on desktop Chrome, one source whose AAC track
had 7 holes of 213 ms (10 packets dropped out of every 94, the rest keeping their timestamps):

| | packet 20 | packet 21 | last |
| --- | --- | --- | --- |
| the packets' timestamps | 0.3840 s | 0.6187 s | 13.9947 s |
| Chrome's `AudioDecoder` output | 0.3840 s | 0.4053 s | 12.5013 s |
| mediabunny's `AudioSampleSink` | 0.3840 s | 0.4053 s | 12.5013 s |

Same for Opus in WebM. The decoder emitted exactly one chunk per packet (588 for 588, 627 for 627).
mediabunny resyncs to a decoder timestamp a whole frame off (`media-sink.js`) and fills a gap of
64 samples or more with silence before the encoder (`media-source.js`), but neither can see a hole
the decoder already closed. So **the ENCODE route** (any non-AAC source, Android's Opus recordings
among them, or an AAC track over 128 kb/s) **wrote the audio contiguous and short, every sound after
a hole early by the sum of the holes before it** - growing to the end of the file:

| Row (rig, VFR video, AAC with 7 holes) | `main` | this change |
| --- | --- | --- |
| 192 kb/s (re-encoded) | audio ends 12.523 s, video 14.000 s; sound early by 209, 427, 639, 856, 1069, 1285, **1494 ms** at seconds 1-13; output audio contiguous | in sync within 1 ms at second 13; audio ends 14.016 s, holes filled with silence |
| 96 kb/s (copied) | in sync by the packets' times, but the 7 holes copied into the output, where Chrome's decoder closes them again on playback | re-encoded, as above |

**That is the production file's signature**: contiguous 1024-tick audio ending 0.845 s before the
picture, the sound running ahead of the picture more and more towards the end (the picture "late").
Its source's own holes are gone from the output, so their places cannot be read back from it; the
shape is the proof, and an old phone dropping audio buffers is the owner's own guess for the source.

**The fix** (`frontend/src/lib/video/audioTimeline.ts`, used by `prepareVideoForUpload.ts`), in two
steps, each from the fact that decides it:

1. **Whether the track has holes - from its PACKETS alone** (`packetHoles`, metadata only, no
   decode). A packet's length is the median step between packets (an MP4's own durations cannot be
   used: it writes each one as the step to the next packet, the hole included), and a hole is a step
   longer by at least `HOLE_MIN_FRAMES` (2) packet lengths. Two, not one: a recorder whose audio
   clock runs slightly fast drifts by a few samples a packet, and a one-frame rule would cut that
   into a 21 ms silence - a click - every time the drift reached a frame (the rig's `drift` row,
   0.5 % fast, finds no hole). The route rests on this fact and never on the uploader's decoder: a
   decoder that keeps timestamps would find no hole, the track would be copied, and a Chrome reader
   would hear it early. A track with holes is ENCODED, even AAC-LC under 128 kb/s, because a copy
   keeps the holes for the player to close (`chooseAudioRoute`'s `hasHoles`).
2. **Where the holes land on this decoder - only for a holed track that is encoded.** The window the
   conversion reads is decoded once, exactly as the conversion will read it (`samples(start, end)`:
   the trim of a CanaReel included), and `audioHoleMap` pairs each chunk with its packet
   (`pairedPackets`: from the packet the first chunk is stamped with, to the last before the
   window's end). A packet at least two chunk lengths later than the decoder put it, beyond the holes
   already counted, is a step; a run of packets earlier than that is ONE overlap, left alone. The
   conversion's audio `process` hook moves each chunk back (`restoreAudioTimestamp`) and cuts what a
   restore pushes past the window's end (the conversion cut its window on the decoder's timeline,
   where a chunk sits earlier than it belongs); mediabunny's encoder fills the gaps with silence. A
   decoder that keeps the packets' timestamps yields no step, correctly: the encoder sees the gaps.

**Nothing here refuses an upload.** A decoder that throws in step 2 (an engine with no AAC decoder,
a corrupt packet) or that does not emit one chunk per packet leaves the route the source would have
had without its holes, and the console says the restore was lost: `audio holes NOT restored (...)`,
at `warn` for a failed decoder and in ONE `console.error` line with the counts for an unpaired one.
A track without holes is never decoded before the conversion. An engine with no AAC encoder
(Firefox) still copies a holed AAC track, holes included, and the console names them. The pre-pass
stops on the member's cancel.

### The video: a variable frame rate, and what a phone does with it

The seam kept each decoded frame's source timestamp and only resampled above 30.5 fps, so a
variable-rate source came out variable-rate, holes included (the production file's 258 ms stalls).
Now the plan's `frameRate` is always `VIDEO_FRAME_RATE` (30): each frame lands on
`floor(t * 30) / 30`; the FIRST frame of each 1/30 s slot is the one encoded, the later ones in
that slot are dropped, and an empty slot repeats the last frame seen. A picture moves by at most one frame, always EARLIER - the direction lip sync tolerates
best. Costs taken knowingly: a 24 or 25 fps clip gets a repeated frame every 4 or 5, and a source's
missing frames become HELD frames, still a visible stutter - the timeline is regular, the frames
the phone never recorded are not invented.

**Played on the Mi 9T** (Chrome 156, the same 14 s 720x1280 file prepared both ways, read with
`requestVideoFrameCallback` and `getVideoPlaybackQuality`; the file itself has 55 gaps over 60 ms):

| Output | Played | Dropped | Gaps over 60 ms (wall / media time) | Longest |
| --- | --- | --- | --- | --- |
| `main` (VFR kept) | whole file | 18 of 316 | 45 / 72 | 348 ms |
| `main` (VFR kept) | through MSE | 18 of 316 | 40 / 70 | 382 ms |
| constant 30 | whole file | 0 of 420 | 1 / 0 | 83 ms |
| constant 30 | through MSE | 0 of 420 | 0 / 0 | 50 ms |

The phone's player ADDS stalls to a variable-rate file (18 frames dropped, 72 media-time gaps where
the file has 55) - the lead's desktop reading of the production post (more gaps than the file
holds) is the same effect. A constant-rate file drops none.

### The rig, and what it still does not cover

[`tools/video-av-sync`](../../../tools/video-av-sync/README.md) makes each source in a headless
Chrome (a white frame and a beep on every whole second; the `vfr` rows drop frames, leave 8-frame
holes and jitter frames by up to +-6 ms; the `holes` rows drop audio packets, one of them
trimmed as a CanaReel; the `drift` row stamps its audio 0.5 % fast), runs the app's own
`prepareVideoForUpload` and judges the output by its PACKETS' times - the decoder's would hide the
very drift it looks for. Every row passes on this change (Windows desktop Chrome, 2026-11-06), the
skew at second 13 at most 1 ms; on `main` the hole rows fail as above and every VFR and 24 fps row
fails the 30 fps grid. Owed:

- **The rig on the phones' own encoders and decoders** (the Android WebView's MediaCodec, WKWebView),
  BEFORE the stable that ships this: the one-chunk-per-packet pairing is CHECKED there by the
  console error above, not yet observed, and the pre-pass decode has not been timed on a phone.
- **A CI gate**: the rig makes its sources with an AAC encoder, which Chrome on Linux lacks; a
  committed AAC source would let the copied-audio rows run on a runner.
- **The production post itself** stays as it is: its holes are no longer in the file.

## Who calls it

- **The post composer and the post editor** - at publish, through `preparePostMedia(file, options)`
  (`media.ts`), the ceiling from `uploadLimits()`. The progress line and its cross
  (`VideoPreparationProgress.svelte`) sit above the composer's bar; the cross stops the publish and
  leaves the composer as it was, with no banner. A refusal names its fault on the composer's banner
  (`publishFailureMessage`).
- **The chat composer** - at PICK time (`useMessaging.prepareMediaFiles`), so the video joins the
  pending strip already prepared. The picked size is no longer compared against the ceiling for a
  video: the encoder's budget is the ceiling instead. Two picks are prepared one after the other.
- **The CanaReels camera** (R3) - calls it on the recorder's `Blob` with `maxSeconds: 90`; the
  screen state is `VideoPreparationState` (`videoPreparationState.svelte.ts`) and the sentences
  are `videoPrepareFailureMessage` (`videoPrepareMessages.ts`), the same three every screen uses.

The output plays on every client that exists, segmented or not: it is an ordinary MP4 to a reader
that reads it whole. Whether it is WRITTEN segmented is a separate switch,
`SEGMENTED_MEDIA_WRITER_ENABLED` ([media-service](../services/media-service.md#the-writer-flip---on-since-2026-10-05)).
