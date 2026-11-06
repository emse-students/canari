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
 * Two steps, each from the fact that decides it:
 *
 * - `packetHoles` - WHETHER the track has holes, read from the PACKETS alone (no decode): it decides
 *   the route, so it must not depend on how this engine's decoder stamps its output;
 * - `audioHoleMap` - WHERE each hole lands on THIS decoder's timeline, by pairing each decoded chunk
 *   with its packet (one per packet - checked, never assumed). Only run for a holed track that is
 *   re-encoded. `restoreAudioTimestamp` then moves a decoded chunk back where its packet says, and
 *   the encoder fills the gap with silence.
 *
 * See docs/wiki/frontend/video-preparation.md#constant-frame-rate-and-the-audio-holes-the-decoder-closes.
 */

/**
 * The smallest hole restored, in packet lengths. One frame of slack would turn a slow timestamp
 * drift (a recorder whose audio clock runs a little fast) into a 21 ms silence - a click - each time
 * the drift reached one frame; two frames is a dropped BUFFER, which a drift never makes at once.
 */
export const HOLE_MIN_FRAMES = 2;

/** What the packets alone say about the holes of a track. */
export interface PacketHoles {
  /** How many holes of at least {@link HOLE_MIN_FRAMES} packet lengths. */
  holes: number;
  /** Their total length, in seconds. */
  holeSeconds: number;
  /** The packet length the holes are measured in: the median step between packets, in seconds. */
  frame: number;
}

/**
 * Whether an audio track has holes, from its packets' timestamps alone.
 *
 * A packet's length is the MEDIAN step between consecutive packets (a container's own durations
 * cannot be used: an MP4 writes each one as the step to the next packet, the hole included). A step
 * longer than that by at least {@link HOLE_MIN_FRAMES} lengths is a hole.
 *
 * @param timestamps Every packet's presentation time, in seconds, in order.
 */
export function packetHoles(timestamps: number[]): PacketHoles {
  const steps = timestamps.slice(1).map((t, i) => t - timestamps[i]);
  if (steps.length === 0) return { holes: 0, holeSeconds: 0, frame: 0 };
  const sorted = [...steps].sort((a, b) => a - b);
  const frame = sorted[Math.floor(sorted.length / 2)];
  let holes = 0;
  let holeSeconds = 0;
  for (const step of steps) {
    const gap = step - frame;
    if (frame > 0 && gap >= HOLE_MIN_FRAMES * frame) {
      holes++;
      holeSeconds += gap;
    }
  }
  return { holes, holeSeconds, frame };
}

/** One hole: from `at` on the decoder's timeline, add `offset` seconds (holes before it included). */
export interface AudioHoleStep {
  at: number;
  offset: number;
}

/** Where the holes land on a decoder's timeline, or why they could not be placed. */
export type AudioHoleMap =
  | { kind: 'map'; steps: AudioHoleStep[]; holes: number; holeSeconds: number; overlaps: number }
  /** The decoder did not emit one chunk per packet, so no chunk can be paired with its packet. */
  | { kind: 'unpaired'; packets: number; decoded: number };

/** One decoded chunk, as the decoder stamped it. */
export interface DecodedChunk {
  /** Its timestamp, in seconds, on the decoder's timeline. */
  timestamp: number;
  /** Its length in seconds (frames / sample rate). */
  duration: number;
}

/**
 * Where the holes land on the decoder's timeline, from the packets' timestamps and the chunks the
 * decoder emitted for them, paired one to one.
 *
 * A hole is counted where a packet starts at least {@link HOLE_MIN_FRAMES} chunk lengths later than
 * the decoder put it, beyond the holes already counted. A decoder that KEEPS the packets' timestamps
 * yields no step at all - correctly: the encoder then sees the gaps itself. An overlap (a run of
 * packets earlier than the decoder put them) is counted once per run and left alone: moving a
 * sound earlier than the one before it would play two sounds at once.
 *
 * @param packetTimestamps The paired packets' presentation times, in seconds, in order.
 * @param decoded Every chunk the decoder emitted for them, in order.
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
  let inOverlap = false;
  for (let i = 1; i < decoded.length; i++) {
    const behind = packetTimestamps[i] - decoded[i].timestamp - base - offset;
    const frame = decoded[i - 1].duration;
    if (behind >= HOLE_MIN_FRAMES * frame) {
      offset += behind;
      holeSeconds += behind;
      steps.push({ at: decoded[i].timestamp, offset });
    }
    const overlapping = behind <= -frame;
    if (overlapping && !inOverlap) overlaps++;
    inOverlap = overlapping;
  }
  return { kind: 'map', steps, holes: steps.length, holeSeconds, overlaps };
}

/**
 * The packets a decoder read from a start to the END of the track, to pair with the chunks it
 * yielded: every packet from the one the first chunk is stamped with (the decoder starts there).
 * Never cut at a window's end - a decoder cuts there on its own collapsed timeline and the packets
 * sit on the real one, so a hole inside the window would leave more chunks than packets; the decode
 * must run to the track's end instead. `audioHoleMap` then refuses the pairing unless there is one
 * chunk per packet. `null` when no packet is where the first chunk says.
 *
 * @param packetTimestamps Every packet of the track, in order.
 */
export function pairedPackets(
  packetTimestamps: number[],
  decoded: DecodedChunk[]
): number[] | null {
  if (decoded.length === 0) return null;
  const first = decoded[0];
  const at = packetTimestamps.findIndex((t) => Math.abs(t - first.timestamp) < first.duration / 2);
  if (at < 0) return null;
  return packetTimestamps.slice(at);
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
