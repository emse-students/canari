/**
 * WHERE A SOURCE'S AUDIO REALLY IS, when the decoder says otherwise.
 *
 * A phone that drops audio buffers while recording (an old Android recorder) writes an audio track
 * with HOLES: packet n+1 starts later than packet n ends, and the container's timestamps say so.
 * Chrome's WebCodecs `AudioDecoder` does not: it stamps its first output with the first packet's
 * time and every later one with the frames decoded so far, so a hole disappears and every sound
 * after it is played EARLY - by the sum of the holes before it, growing towards the end of the
 * file (measured 2026-11-06: 7 holes of 213 ms in a 14 s AAC track came out of the decoder 1.49 s
 * short, and an encoded output ended with its sound 1.49 s ahead of its picture). mediabunny resyncs
 * to the decoder's timestamps, so it cannot see the hole either.
 *
 * The packets still carry the truth. `audioHoleMap` pairs each decoded chunk with its packet (the
 * decoder emits exactly one per packet - checked, never assumed) and returns where each hole
 * starts on the decoder's timeline and how much later everything after it belongs;
 * `restoreAudioTimestamp` moves a decoded chunk back there. The encoder then sees the gap and fills
 * it with silence, so the output is contiguous AND in sync. See
 * docs/wiki/frontend/video-preparation.md#constant-frame-rate-and-the-audio-holes-the-decoder-closes.
 */

/** One hole: from `at` on the decoder's timeline, add `offset` seconds (holes before it included). */
export interface AudioHoleStep {
  at: number;
  offset: number;
}

/** The holes of one track, or why they could not be placed. */
export type AudioHoleMap =
  | { kind: 'map'; steps: AudioHoleStep[]; holes: number; holeSeconds: number; overlaps: number }
  /** The decoder did not emit one chunk per packet, so no chunk can be paired with its packet. */
  | { kind: 'unpaired'; packets: number; decoded: number };

/** One decoded chunk, as the decoder stamped it. */
export interface DecodedChunk {
  /** Its timestamp, in seconds, on the decoder's (collapsed) timeline. */
  timestamp: number;
  /** Its length in seconds (frames / sample rate). */
  duration: number;
}

/**
 * The holes of an audio track, from its packets' timestamps and the decoder's chunks.
 *
 * A hole is counted where a packet starts at least one chunk's length later than the decoder put it,
 * beyond the holes already counted - the same "a whole frame off" rule mediabunny uses to resync, so
 * a few hundred microseconds of timestamp jitter is never a hole. A packet EARLIER than the decoder
 * put it (an overlap) is counted and left alone: shifting a sound earlier than the one before it
 * would play two sounds at once.
 *
 * @param packetTimestamps Every packet's presentation time, in seconds, in order.
 * @param decoded Every chunk the decoder emitted, in order.
 */
export function audioHoleMap(packetTimestamps: number[], decoded: DecodedChunk[]): AudioHoleMap {
  if (packetTimestamps.length !== decoded.length || decoded.length === 0) {
    return { kind: 'unpaired', packets: packetTimestamps.length, decoded: decoded.length };
  }
  // The decoder may place its first chunk off the first packet (Opus pre-skip): that is a constant.
  const base = packetTimestamps[0] - decoded[0].timestamp;
  const steps: AudioHoleStep[] = [];
  let offset = 0;
  let holeSeconds = 0;
  let overlaps = 0;
  for (let i = 1; i < decoded.length; i++) {
    const behind = packetTimestamps[i] - decoded[i].timestamp - base - offset;
    const frame = decoded[i - 1].duration;
    if (behind >= frame) {
      offset += behind;
      holeSeconds += behind;
      steps.push({ at: decoded[i].timestamp, offset });
    } else if (behind <= -frame) {
      overlaps++;
    }
  }
  return { kind: 'map', steps, holes: steps.length, holeSeconds, overlaps };
}

/**
 * Where a decoded chunk stamped `timestamp` (on the decoder's timeline) really belongs.
 *
 * @param steps The map's steps, in order.
 */
export function restoreAudioTimestamp(steps: AudioHoleStep[], timestamp: number): number {
  // A chunk stamped exactly where a hole ends belongs after it; a microsecond absorbs the rounding
  // of the decoder's timestamps to its sample rate.
  let offset = 0;
  for (const step of steps) {
    if (step.at > timestamp + 1e-6) break;
    offset = step.offset;
  }
  return timestamp + offset;
}
