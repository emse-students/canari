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
what the phones might be doing - a wrong key, no receiver transform, a sender that encrypts twice -
and must FAIL; their signatures are what a phone reading is compared with.
