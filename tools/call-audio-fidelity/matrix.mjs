/**
 * The rows the rig runs and the thresholds a row must meet. A row is one call: the CALLER's fake
 * microphone plays the reference, the CALLEE records what it decodes. `caller` / `callee` are the
 * `RigConfig` of `page/page.ts` for each side.
 *
 * A row marked `gated` fails the run when it misses a threshold: those are the app's OWN settings,
 * the ones a user hears. The others are experiments and context - they are measured and printed,
 * never gated, because their job is to explain a gated number, not to be one.
 */

const APP = { processing: 'app', e2e: true };
const RAW = { processing: 'off', e2e: true };

export const MATRIX = [
  {
    name: 'app',
    what: 'the app as shipped: its constraints, its sender parameters, its SDP, E2E on',
    gated: true,
    caller: APP,
    callee: APP,
  },
  {
    name: 'app-doubletalk',
    what: 'the app, with the far end talking at the same time (AEC and suppressor engaged)',
    gated: true,
    farTalk: true,
    caller: APP,
    callee: APP,
  },
  {
    name: 'app-no-e2e',
    what: 'the app without the E2E transform - isolates what the transform costs',
    caller: { ...APP, e2e: false },
    callee: { ...APP, e2e: false },
  },
  {
    name: 'raw',
    what: 'every browser voice processing step off (no AEC, NS, AGC), E2E on',
    caller: RAW,
    callee: RAW,
  },
  {
    name: 'app-loss5',
    what: 'the app, 5 % random packet loss on the receiver',
    gated: true,
    caller: APP,
    callee: { ...APP, impair: { loss: 0.05, burst: 1, seed: 11 } },
  },
  {
    name: 'raw-loss5',
    what: 'processing off, 5 % random packet loss - separates a loss artefact from the voice processing',
    caller: RAW,
    callee: { ...RAW, impair: { loss: 0.05, burst: 1, seed: 11 } },
  },
  {
    name: 'no-e2e-loss5',
    what: 'the app without encryption (a pass-through transform), 5 % loss - separates a loss artefact from the E2E transform',
    caller: { ...APP, e2e: false },
    callee: { ...APP, e2e: false, impair: { loss: 0.05, burst: 1, seed: 11 } },
  },
  {
    name: 'app-loss15-jitter',
    what: 'the app, 15 % bursty loss (mean burst 2) and up to 40 ms jitter on the receiver',
    caller: APP,
    callee: { ...APP, impair: { loss: 0.15, burst: 2, jitterMs: 40, seed: 13 } },
  },
  {
    name: 'red',
    what: 'EXPERIMENT: Opus RED (RFC 2198 redundancy) negotiated first, E2E on',
    caller: { ...APP, codecOrder: ['audio/red', 'audio/opus'] },
    callee: { ...APP, codecOrder: ['audio/red', 'audio/opus'] },
  },
  {
    name: 'red-no-e2e',
    what: 'EXPERIMENT: Opus RED negotiated first, no E2E transform',
    caller: { ...APP, e2e: false, codecOrder: ['audio/red', 'audio/opus'] },
    callee: { ...APP, e2e: false, codecOrder: ['audio/red', 'audio/opus'] },
  },
  {
    name: 'dtx',
    what: 'EXPERIMENT: Opus DTX on (1-byte frames in pauses), E2E on',
    caller: { ...APP, fmtp: { usedtx: '1' } },
    callee: { ...APP, fmtp: { usedtx: '1' } },
  },
  {
    name: 'late-mline',
    what: 'SCENARIO: the callee sends on a NEW m-line after the first negotiation; the caller attaches its receiver transform in ontrack (the late path of the app). Measures callee -> caller',
    measure: 'down',
    caller: APP,
    callee: { ...APP, lateTrack: true },
  },
  {
    name: 'late-reuse',
    what: "SCENARIO: the callee's late audio REUSES the transceiver the caller's offer created (addTrack); its sender got its transform in ontrack, as the app does since 2026-10-20. Measures callee -> caller",
    measure: 'down',
    caller: APP,
    callee: { ...APP, lateTrack: true, reuseRemoteTransceiver: true },
  },
  {
    name: 'fault-wrong-key',
    what: 'FAULT: the callee derives a different key (two MLS epochs, review item F5)',
    fault: true,
    caller: APP,
    callee: { ...APP, wrongKey: true },
  },
  {
    name: 'fault-double-encrypt',
    what: 'FAULT: the caller encrypts every frame twice - the callee decrypts once and decodes ciphertext',
    fault: true,
    caller: { ...APP, doubleEncrypt: true },
    callee: APP,
  },
  {
    name: 'fault-no-decrypt',
    what: 'FAULT: the callee attaches no receiver transform - ciphertext reaches its decoder',
    fault: true,
    caller: APP,
    callee: { ...APP, noReceiverTransform: true },
  },
  {
    name: 'fault-transform-late',
    what: "FAULT: both sides assign their transforms one task after addTrack (the app's order until 2026-10-20) - Chromium short-circuits them, clear media flows around the worker",
    fault: true,
    caller: { ...APP, transformOneTaskLate: true },
    callee: { ...APP, transformOneTaskLate: true },
  },
  {
    name: 'fault-reuse-bare-sender',
    what: "FAULT: the callee's ontrack leaves the offer-created transceiver's sender bare (the app until 2026-10-20) and addTrack reuses it later - Chromium short-circuited it at creation, the callee's audio leaves in clear",
    measure: 'down',
    fault: true,
    caller: APP,
    callee: { ...APP, lateTrack: true, reuseRemoteTransceiver: true, bareSenderInOntrack: true },
  },
];

/**
 * What the GATED rows must meet. Set from the clean baseline measured on Chrome 155, 2026-10-19
 * (calls.md, "Audio quality, measured 2026-10-19"), with a margin. Two of them are NOT codec limits
 * and say so: the browser's voice processing (AEC/NS/AGC, which the app asks for) cuts the sweep
 * above ~10.4 kHz and gates one ~170 ms onset in the reference - both identical with and without
 * the E2E transform, with and without RED, and both absent with processing off.
 */
export const THRESHOLDS = {
  /** Median block correlation with the reference: THE noise detector. Ciphertext reads < 0.1. */
  minMatch: 0.9,
  minMatchLossy: 0.8,
  /** Decrypted frames that are not byte-identical to an encoded one. Any is corruption. */
  maxCorruptedFrames: 0,
  /** Log-spectral distance on the speech segment, dB. The baseline reads 3.9-5.5. */
  maxSpeechLsdDb: 7,
  /** High band (> 4 kHz) relative to the low band, dB. A narrow-band codec mode reads < -20. */
  minSpeechHfTiltDb: -6,
  /** Highest sweep frequency within 10 dB of the 300-3000 Hz level (voice processing: 10.4 kHz). */
  minBandwidthHz: 9_000,
  /** Total speech-time dropout, ms, on a clean network (voice processing's one onset: 170 ms). */
  maxDropoutMsClean: 250,
  /** Concealed share of received samples on a clean network, %. */
  maxConcealedPctClean: 1,
  /** Samples at full scale on a clean network (under loss, Opus concealment can overshoot). */
  maxClippedClean: 0,
  /** The app worker's own witness lines (`opusInvalid`, `doubleEncrypted`) in either page's log. */
  maxWitnessLines: 0,
};

/** Log lines in which the app's E2E worker named a non-Opus payload or a double encryption. */
export function witnessLines(r) {
  return (r.log ?? []).filter((l) => /"type":"(opusInvalid|doubleEncrypted)"/.test(l)).length;
}

/**
 * On an E2E row, both transforms must have been handed frames by the engine (the worker's own
 * `report`): an engine can accept `sender.transform = x` and still route the media around it.
 * A row without E2E, or a result saved before the report existed, is not judged by it.
 */
export function transformInPath(r) {
  const t = r.transformPath;
  if (!t?.e2e) return true;
  return t.senderFrames > 0 && t.receiverFrames > 0;
}

/**
 * Applies the thresholds to one result. Rows with injected loss skip the clean-network checks.
 * A FAULT row must FAIL: one that passes means the rig cannot see that fault any more.
 */
export function verdict(r) {
  const sp = r.metrics.segments.speech;
  const lossy = (r.impairDropped ?? 0) > 0;
  const corrupted = r.bitExact?.measured?.corrupted ?? 0;
  const checks = [
    ['match', r.metrics.matchCoef >= (lossy ? THRESHOLDS.minMatchLossy : THRESHOLDS.minMatch)],
    ['corrupted-frames', corrupted <= THRESHOLDS.maxCorruptedFrames],
    ['witness', witnessLines(r) <= THRESHOLDS.maxWitnessLines],
    ['transform-in-path', transformInPath(r)],
    ['lsd', sp.lsdDb <= THRESHOLDS.maxSpeechLsdDb],
    ['hf-tilt', sp.hfLossDb >= THRESHOLDS.minSpeechHfTiltDb],
    ['bandwidth', r.metrics.bandwidthHz >= THRESHOLDS.minBandwidthHz],
  ];
  if (!lossy) {
    checks.push(['dropouts', r.metrics.dropouts.ms <= THRESHOLDS.maxDropoutMsClean]);
    checks.push(['concealment', r.concealedPct <= THRESHOLDS.maxConcealedPctClean]);
    checks.push(['clipping', r.metrics.clippedSamples <= THRESHOLDS.maxClippedClean]);
  }
  const failed = checks.filter(([, ok]) => !ok).map(([n]) => n);
  const pass = failed.length === 0;
  return { pass, failed, gated: !!r.gated, fault: !!r.fault, ok: r.fault ? !pass : pass };
}
