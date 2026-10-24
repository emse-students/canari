# call-audio-fidelity - what a call does to a KNOWN sound

Two headless Chrome processes call each other through the app's own audio path, each with a fake
microphone playing a known file; the receiver records the decoded audio sample for sample, both
sides read `getStats()` every second, and the recording is scored against the reference. No account,
no estate, no phone. Built 2026-10-19 for "the call audio sounds horrible" / "a formless noise
instead of a sound"; the results and the reading of them are in
[calls.md, "Audio quality, measured 2026-10-19"](../../docs/wiki/frontend/modules/calls.md#audio-quality-measured-2026-10-19).

```sh
bun test tools/call-audio-fidelity                 # self-test of the metrics (no browser)
bun tools/call-audio-fidelity/rig.mjs              # the whole matrix, ~45 s a row
bun tools/call-audio-fidelity/rig.mjs --only app,fault-no-decrypt --seconds 34 --out <dir> --keep
```

`--chrome <path>` (default: the Windows install), `--seconds` (at least 34: the analysis skips 8 s
and needs two whole 12 s loops), `--out` (default: the OS temp dir), `--keep` (keep the profiles).
Run nothing else heavy at the same time: two Chromes encoding and decoding in real time on a loaded
host conceal and stretch for reasons that are the HOST's, and the rows read worse than the app is.
The exit code fails when a gated row misses a threshold, when a FAULT row passes (the rig can no
longer see that fault), or when a row does not complete.

## What is real and what is a stand-in

| Part                                   | Source                                                                                                                                                                                                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capture constraints, sender parameters | IMPORTED from `frontend/src/lib/utils/callAudio.ts`                                                                                                                                                                                                                                   |
| E2E frame transform                    | the app's `encryption.worker.ts`, IMPORTED, wrapped by `page/impair.worker.ts` only to drop/delay frames, tap them, or inject a fault                                                                                                                                                 |
| Order of operations                    | `CallService.initPeerConnection`'s: `addTrack`, sender transform, the receiver transform of the same transceiver before negotiation, `configureCallAudioSenders`, implicit `setLocalDescription()`; a receiver without a transform gets one in `ontrack`, as `handleRemoteTrack` does |
| Playback                               | an `<audio>` element on the remote stream, as `CallOverlay.svelte`; recorded through an `AudioWorklet` at 48 kHz                                                                                                                                                                      |
| Stand-ins                              | a fixed test key (not an MLS export), the driver carrying SDP (not the relay socket), host candidates on loopback, no ring                                                                                                                                                            |

## The reference (`signal.mjs`)

12 s, 48 kHz mono, 16-bit, deterministic (seeded): a log sweep 80 Hz-20 kHz, a speech-like segment
(voiced syllables with formants and fricatives, syllabic rhythm, pauses), eight tones 300 Hz-10 kHz,
band-limited noise. The far-end file (`far.wav`) is speech-like only, so it shares nothing with the
reference. Nothing is committed: the WAVs are rebuilt in `--out` on every run.

## The metrics (`analyze.mjs`, self-tested by `analyze.test.mjs`)

The first whole loop after 8 s is located by circular cross-correlation, then followed block by
block (50 ms, +/-30 ms around the previous block, median-smoothed) because NetEq's time-stretching
moves the lag during a call.

| Metric               | Reads                                                                                                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `match`              | median normalised correlation of the blocks with the reference: ~1 = the reference came out; < 0.1 = unrelated noise or silence                                                                                                                                                 |
| frames bit-exact     | every DECRYPTED payload looked up, by a 32-bit FNV-1a hash and its length, among the payloads the other side ENCODED (`page/impair.worker.ts` taps both, across the two processes) - a membership check, not a full byte compare                                                |
| speech SNR / LSD     | waveform SNR and log-spectral distance on the speech segment, after a least-squares gain                                                                                                                                                                                        |
| HF tilt              | energy above 4 kHz relative to below, dB (an AGC moving everything is not a lost band)                                                                                                                                                                                          |
| bandwidth            | highest sweep frequency within 10 dB of its 300-3000 Hz level                                                                                                                                                                                                                   |
| dropouts             | runs >= 20 ms where speech was sent and the output sits 30 dB below it                                                                                                                                                                                                          |
| concealed %, stretch | `concealedSamples`, `inserted/removedSamplesFor...` over `totalSamplesReceived`                                                                                                                                                                                                 |
| floor                | level in the digital silences between segments, dBFS                                                                                                                                                                                                                            |
| witness              | lines in which the app's worker named a non-Opus payload or a double encryption (`opusInvalid`, `doubleEncrypted`); any one fails the row (`matrix.test.mjs`)                                                                                                                   |
| transform-in-path    | the app worker's own `report` (what `CallService` asks 5 s after connected): on an E2E row, a sender or receiver transform handed NO frame fails the row - media flowing around the worker. `--chrome` runs another engine (Chrome for Testing 152 = the Mi 9T's WebView major) |

## The matrix (`matrix.mjs`)

Gated rows are the app as shipped (clean, double talk, 5 % loss). Experiments (no E2E, processing
off, RED, DTX, loss with and without E2E, a late m-line) explain a gated number. FAULT rows inject
what the phones might be doing - a wrong key, no receiver transform, a sender that encrypts twice,
transforms assigned one task after `addTrack` - and must FAIL; their signatures are what a phone
reading is compared with. `fault-transform-late` is the app's order until 2026-10-20: Chromium
short-circuits both transforms, the audio is CLEAN and unencrypted, and only `transform-in-path`
fails it - which is why clean audio is never evidence of E2E. `late-reuse` puts the callee's late
audio on the transceiver the caller's offer created (`addTrack` reuses it; `ontrack` armed its
sender, as the app does) and must PASS; `fault-reuse-bare-sender` leaves that sender bare in
`ontrack`, as the app did, and must fail
([calls](../../docs/wiki/frontend/modules/calls.md#call-e2e-bypass-mi9t-2026-10-20---chromium-short-circuits-a-transform-assigned-one-task-late)).

## The video rows (2026-10-20)

`video`, `video-camera-late`, `video-switch` and `video-off-on` are GATED: both pages send Chrome's
fake camera (`--use-fake-device-for-media-stream=fps=30`) through the app's own worker, with the
app's `callVideoConstraints`, `applyCallVideoRung` and `preferVp8` IMPORTED from
`frontend/src/lib/utils/callVideo.ts`. Each adds these checks (`videoChecks`, self-tested by
`matrix.test.mjs`):

| Check                 | Reads                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| `video-in-path`       | the worker's `framesInBy` for video, both sides > 0                                                    |
| `video-decrypted`     | decrypted video frames > 0 and `decryptFailuresBy.video` = 0                                           |
| `video-codec`         | the inbound video codec is VP8                                                                         |
| `video-fps`           | decoded frames per second >= 27                                                                        |
| `video-freezes`       | `freezeCount` = 0                                                                                      |
| `video-keyframes`     | `keyFramesDecoded` <= 8 (a ladder change adds one) - a storm is a header the depacketiser cannot read  |
| `video-picture`       | the mean colour of the received picture within 24 of the sent one (32x24 canvas, both before `finish`) |
| `video-fed-after-op`  | after a switch or an off/on, the sender transform is still handed frames                               |
| `video-mute-when-off` | the peer's remote track mutes while the camera is off, and unmutes after                               |

Since 2026-10-21 each camera runs the app's quality ladder (`callVideoQuality.ts`, IMPORTED, sampled
as `CallService` samples it) and the video table adds the SENDER's side: the size and rate it sent,
its encoder, `totalEncodeTime / framesEncoded` (ms a frame, and that times the frame rate as a share
of one core) and the rung the ladder ended on with its changes. `video-rung-720p`, `video-rung-480p`
and `video-rung-360p` are experiments that HOLD one rung (`videoRung`) to measure its encode cost
apart. The rig cannot make the ladder drop: its impairment acts on frames at the receiver
transform, never on the wire the congestion controller reads
([calls](../../docs/wiki/frontend/modules/calls.md#the-quality-ladder-2026-10-21---720p-and-an-automatic-drop)).

`video-whole-frame` (VP8 encrypted whole) and `video-h264` (H.264 negotiated, encrypted whole) are
the experiments that justify the clear header and the VP8-only rule; `fault-video-bare-sender` puts
the callee's camera on the REUSED sender the caller's offer created, left bare, and must fail
`video-in-path` and `video-decrypted`. The run writes a video table to `results.md`
([calls](../../docs/wiki/frontend/modules/calls.md#video-lot-2-2026-10-20---vp8-behind-a-clear-header-held-by-every-transceiver)).
