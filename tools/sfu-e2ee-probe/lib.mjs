/**
 * The verdict of the Q4 probe (`probe.mjs`), kept apart from the browsers and the network so its
 * rules are tested on their own (`lib.test.mjs`).
 *
 * WHAT IT DECIDES. Whether frames the app's own E2E transform encrypted crossed Cloudflare
 * Realtime's raw SFU and were opened by the receiver's transform - and whether they arrived BYTE
 * FOR BYTE as the sender's transform wrote them. Every verdict is a count reached or a fact seen,
 * never a duration (CLAUDE.md, "termination from a proof").
 */

/** How many times the audio proof's frame count the subscriber may receive with no video packet. */
export const VIDEO_ABSENT_AFTER_AUDIO_MULTIPLE = 4;

/**
 * A frame's digest as the probe worker writes it: `<byteLength>:<16 hex>`. The length is part of the
 * digest so two frames of different sizes never compare equal, and so sizes are read back from it.
 */
export function digestSize(digest) {
  const n = Number(String(digest).split(':', 1)[0]);
  return Number.isFinite(n) ? n : NaN;
}

/** Min, median and max of a list of sizes, or nulls for an empty one. */
export function sizeSummary(sizes) {
  if (sizes.length === 0) return { count: 0, min: null, median: null, max: null };
  const s = [...sizes].sort((a, b) => a - b);
  return { count: s.length, min: s[0], median: s[Math.floor(s.length / 2)], max: s[s.length - 1] };
}

/**
 * Holds what the SUBSCRIBER's receiver transform was handed (before any decrypt) against what the
 * PUBLISHER's sender transform wrote (after encrypting): every received digest must be one the
 * publisher sent. `byteIdentical` is true only when at least one frame was compared and none
 * differed - an empty comparison proves nothing.
 *
 * @param {string[]} sent digests of the publisher's encrypted frames, in order
 * @param {string[]} received digests of the subscriber's frames before decryption, in order
 */
export function compareDigests(sent, received) {
  const sentSet = new Set(sent);
  let matched = 0;
  const unmatchedSamples = [];
  for (const d of received) {
    if (sentSet.has(d)) matched++;
    else if (unmatchedSamples.length < 5) unmatchedSamples.push(d);
  }
  const unmatched = received.length - matched;
  return {
    matched,
    unmatched,
    unmatchedSamples,
    byteIdentical: received.length > 0 && unmatched === 0,
    sentSizes: sizeSummary(sent.map(digestSize)),
    receivedSizes: sizeSummary(received.map(digestSize)),
  };
}

const kinds = (opts) => (opts.video ? ['audio', 'video'] : ['audio']);
const need = (opts, kind) => (kind === 'audio' ? opts.frames : opts.videoFrames);

/**
 * Why the probe has FAILED, named, or null while it may still pass. `pub` and `sub` are the two
 * pages' `state()`; `opts` is `{ frames, videoFrames, video }`.
 */
export function failureOf(pub, sub, opts) {
  for (const [name, st] of [
    ['publisher', pub],
    ['subscriber', sub],
  ]) {
    if (st.fault) return `${name}: ${st.fault}`;
    if (st.connectionState === 'failed')
      return `${name}: the peer connection to Cloudflare FAILED (ICE or DTLS)`;
    if ((st.report?.transformErrors ?? 0) > 0)
      return `${name}: the E2E transform threw ${st.report.transformErrors} time(s)`;
    if ((st.report?.droppedNoKey ?? 0) > 0)
      return `${name}: ${st.report.droppedNoKey} frame(s) met the transform before its keys`;
  }
  const failures = sub.report?.decryptFailures ?? 0;
  if (failures > 0)
    return (
      `subscriber: ${failures} frame(s) failed to decrypt ` +
      `(audio ${sub.report.decryptFailuresBy?.audio ?? '?'}, video ${sub.report.decryptFailuresBy?.video ?? '?'}) - ` +
      'the SFU altered the encrypted payload or the clear header bound as AAD'
    );
  if (opts.video && (pub.report?.videoCodecUnexpected ?? 0) > 0)
    return 'publisher: video frames of a codec other than VP8 met the transform - the VP8 hold did not apply';
  for (const kind of kinds(opts)) {
    const packets = sub.inbound?.[kind]?.packetsReceived ?? 0;
    const framesIn = sub.report?.framesIn?.receiver ?? 0;
    // The transform is not in the path: packets arrived and the receiver transform saw no frame, or
    // saw frames and opened none of this kind. No later packet routes through it
    // (CALL-E2E-BYPASS-MI9T), so this is final.
    if (packets >= need(opts, kind) && framesIn === 0)
      return `subscriber: ${packets} ${kind} packets received and the receiver transform was handed NO frame - bypassed`;
    if (packets >= need(opts, kind) && (sub.report?.decrypted?.[kind] ?? 0) === 0)
      return `subscriber: ${packets} ${kind} packets received and 0 ${kind} frames decrypted - the transform is not in the path`;
  }
  if (opts.video) {
    const audioIn = sub.inbound?.audio?.packetsReceived ?? 0;
    const videoIn = sub.inbound?.video?.packetsReceived ?? 0;
    if (audioIn >= opts.frames * VIDEO_ABSENT_AFTER_AUDIO_MULTIPLE && videoIn === 0)
      return (
        `subscriber: ${audioIn} audio packets and NO video packet received ` +
        `(publisher sent ${pub.outbound?.video?.packetsSent ?? 0}) - the SFU did not forward the video track`
      );
  }
  return null;
}

/** Whether the probe has PROVEN its claim: enough frames encrypted, crossed and decrypted per kind. */
export function provenOf(pub, sub, opts) {
  return kinds(opts).every((kind) => {
    const n = need(opts, kind);
    const ok =
      (pub.report?.encrypted?.[kind] ?? 0) >= n &&
      (sub.report?.decrypted?.[kind] ?? 0) >= n &&
      (sub.inbound?.[kind]?.packetsReceived ?? 0) > 0;
    // A remote video that never receives a key frame stays black, however many deltas open.
    return kind === 'video' ? ok && (sub.report?.videoKeyframesIn ?? 0) > 0 : ok;
  });
}

/** One progress line of both pages, for the run log. */
export function brief(pub, sub) {
  const k = (st, side, kind) =>
    side === 'enc' ? (st.report?.encrypted?.[kind] ?? 0) : (st.report?.decrypted?.[kind] ?? 0);
  return (
    `pub enc a=${k(pub, 'enc', 'audio')} v=${k(pub, 'enc', 'video')} pc=${pub.connectionState} | ` +
    `sub rx a=${sub.inbound?.audio?.packetsReceived ?? 0} v=${sub.inbound?.video?.packetsReceived ?? 0} ` +
    `dec a=${k(sub, 'dec', 'audio')} v=${k(sub, 'dec', 'video')} ` +
    `failed=${sub.report?.decryptFailures ?? 0} pc=${sub.connectionState}`
  );
}
