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

- **Any source**: Android's `MediaRecorder` WebM (VP8/VP9 + Opus), iOS's MP4/MOV (H.264 or HEVC +
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
**Real camera clips, cancel and the in-app progress are read with the composer wiring** (below).

## Who calls it

- **The post and chat composers** - owed with the composer wiring, which shows the progress and the
  cancel.
- **The CanaReels camera** (R3) - calls it on the recorder's `Blob` with `maxSeconds: 90`.

The output plays on every client that exists, segmented or not: it is an ordinary MP4 to a reader
that reads it whole. Whether it is WRITTEN segmented is a separate switch,
`SEGMENTED_MEDIA_WRITER_ENABLED` ([media-service](../services/media-service.md#the-writer-flip---what-this-release-does-not-do)).
