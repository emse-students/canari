# Video preparation: the phone compresses, the server stores (CanaReels R2, decision C3)

**Every video leaves the device as ONE format, made ON the device**: a fragmented MP4, H.264 + AAC,
720p on its short side at ~2.5 Mb/s, at most 30 fps, rotation baked into the frames, in a `File`
whose `type` names its codecs. The server transcodes nothing and draws no thumbnail - the user's
decision C3, 2026-09-29 (*"il faut que la charge serveur soit minimale"*), recorded on
[backlog](../backlog.md#the-composer-and-canareels-chantier---compared-on-the-mi-9t-2026-09-29-every-decision-taken).

## The seam - `prepareVideoForUpload` (`frontend/src/lib/video/prepareVideoForUpload.ts`)

```ts
prepareVideoForUpload(source: Blob, {
  maxSeconds?: number,          // 90 for a CanaReel (C4); omitted = only the byte budget bounds it
  maxBytes?: number,            // MediaService.uploadLimits().maxPlaintextBytes
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
| `unsupported` | this engine cannot decode the source or encode H.264/AAC - read as a FACT from the conversion's discarded tracks, before a frame is touched | say this device cannot prepare it |
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
| Audio | AAC, 128 kb/s | |
| Frame rate | resampled to 30 when the source is over 30.5 | a 60 fps gallery clip costs twice for no reader |
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
