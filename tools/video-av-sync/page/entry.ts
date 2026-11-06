/**
 * The page the A/V sync rig drives: it MAKES a source with a known sync, runs it through the app's
 * own `prepareVideoForUpload` (imported, not copied) and reads the output back the way a player
 * schedules it - every frame's presentation time and brightness, every audio sample's time.
 */
import * as mb from 'mediabunny';
import { prepareVideoForUpload } from '../../../frontend/src/lib/video/prepareVideoForUpload';
import { audioHoleCount, audioOnsets, beepSample, frameSchedule, judge, seeded } from '../lib.mjs';

/** One row of the rig. */
interface Case {
  name: string;
  /** The source's container and codecs. */
  container: 'mp4' | 'webm';
  /** `cfr` or `vfr` (see `frameSchedule`). */
  mode: 'cfr' | 'vfr';
  fps: number;
  seconds: number;
  /** The source's audio bitrate: at most 128 kb/s an AAC-LC track is copied, above it re-encoded. */
  audioBitrate: number;
  /**
   * Drops 10 audio packets (213 ms) out of every 94, the rest keeping their timestamps: a recorder
   * that lost audio buffers. The beeps all sit outside the holes, so every one must still be heard.
   */
  audioHoles?: boolean;
  /**
   * Stamps audio packet n at n x 1029 samples instead of n x 1024: a recorder whose audio clock runs
   * 0.5 % fast. No packet is missing, so no hole may be restored - a restore at every whole frame of
   * drift would be a 21 ms silence, a click, every 4 s.
   */
  audioDrift?: boolean;
  /** Prepared as a CanaReel is: cut to the video's own span (`trimToVideo`). */
  trimToVideo?: boolean;
}

const SAMPLE_RATE = 48_000;
const W = 360;
const H = 640;

/** Builds the source file: frames on `frameSchedule`, a beep on every whole second. */
async function makeSource(c: Case): Promise<File> {
  const output = new mb.Output({
    format: c.container === 'mp4' ? new mb.Mp4OutputFormat() : new mb.WebMOutputFormat(),
    target: new mb.BufferTarget(),
  });
  const video = new mb.VideoSampleSource({
    codec: c.container === 'mp4' ? 'avc' : 'vp8',
    bitrate: 1_000_000,
    keyFrameInterval: 1,
  });
  const audio = new mb.AudioSampleSource({
    codec: c.container === 'mp4' ? 'aac' : 'opus',
    bitrate: c.audioBitrate,
  });
  output.addVideoTrack(video);
  output.addAudioTrack(audio);
  await output.start();

  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d')!;
  const schedule = frameSchedule({ seconds: c.seconds, fps: c.fps, mode: c.mode });
  const noise = seeded(11);
  const frames = Math.ceil(c.seconds * SAMPLE_RATE);
  let fed = 0;
  // Interleaved by time, as a recorder writes: the audio up to each frame, then the frame.
  const feedAudioUntil = async (t: number) => {
    while (fed < Math.min(frames, Math.round(t * SAMPLE_RATE))) {
      const n = Math.min(1024, frames - fed);
      const data = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        const s = beepSample((fed + i) / SAMPLE_RATE, noise());
        data[i] = s;
        data[n + i] = s;
      }
      const sample = new mb.AudioSample({
        data,
        format: 'f32-planar',
        numberOfChannels: 2,
        sampleRate: SAMPLE_RATE,
        timestamp: fed / SAMPLE_RATE,
      });
      await audio.add(sample);
      sample.close();
      fed += n;
    }
  };
  for (let i = 0; i < schedule.timestamps.length; i++) {
    await feedAudioUntil(schedule.timestamps[i]);
    ctx.fillStyle = schedule.flash[i] ? '#ffffff' : '#202020';
    ctx.fillRect(0, 0, W, H);
    const sample = new mb.VideoSample(canvas, {
      timestamp: schedule.timestamps[i],
      duration: schedule.durations[i],
    });
    await video.add(sample);
    sample.close();
  }
  await feedAudioUntil(c.seconds);
  video.close();
  audio.close();
  await output.finalize();
  const type = c.container === 'mp4' ? 'video/mp4' : 'video/webm';
  return new File([output.target.buffer!], `${c.name}.${c.container}`, { type });
}

/**
 * The same file with its audio packets re-stamped or left out by `retime(n, packet)` (`null` drops
 * packet n); the video is copied untouched.
 */
async function remuxAudio(
  file: File,
  retime: (n: number, packet: import('mediabunny').EncodedPacket) => number | null
): Promise<File> {
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  const vTrack = (await input.getPrimaryVideoTrack())!;
  const aTrack = (await input.getPrimaryAudioTrack())!;
  const output = new mb.Output({ format: new mb.Mp4OutputFormat(), target: new mb.BufferTarget() });
  const video = new mb.EncodedVideoPacketSource((await vTrack.getCodec())!);
  const audio = new mb.EncodedAudioPacketSource((await aTrack.getCodec())!);
  output.addVideoTrack(video);
  output.addAudioTrack(audio);
  await output.start();
  const vConfig = (await vTrack.getDecoderConfig())!;
  const aConfig = (await aTrack.getDecoderConfig())!;
  const vPackets = new mb.EncodedPacketSink(vTrack).packets();
  const aPackets = new mb.EncodedPacketSink(aTrack).packets();
  let v = await vPackets.next();
  let a = await aPackets.next();
  let n = 0;
  let firstV = true;
  let firstA = true;
  // Interleaved by time, as the muxer wants them.
  while (!v.done || !a.done) {
    if (!v.done && (a.done || v.value.timestamp <= a.value.timestamp)) {
      await video.add(v.value, firstV ? { decoderConfig: vConfig } : undefined);
      firstV = false;
      v = await vPackets.next();
    } else if (!a.done) {
      const at = retime(n, a.value);
      if (at !== null) {
        const packet = a.value.clone({ timestamp: at });
        await audio.add(packet, firstA ? { decoderConfig: aConfig } : undefined);
        firstA = false;
      }
      n++;
      a = await aPackets.next();
    }
  }
  video.close();
  audio.close();
  await output.finalize();
  input.dispose();
  return new File([output.target.buffer!], file.name, { type: file.type });
}

/** Reads a file back: every frame's time and brightness, every audio chunk with its time. */
async function read(file: Blob) {
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  const vTrack = (await input.getPrimaryVideoTrack())!;
  const aTrack = (await input.getPrimaryAudioTrack())!;
  const probe = new OffscreenCanvas(8, 8);
  const pctx = probe.getContext('2d', { willReadFrequently: true })!;
  const frames: { timestamp: number; duration: number; luma: number }[] = [];
  for await (const s of new mb.VideoSampleSink(vTrack).samples()) {
    s.draw(pctx, 0, 0, 8, 8);
    const px = pctx.getImageData(0, 0, 8, 8).data;
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) sum += px[i];
    frames.push({ timestamp: s.timestamp, duration: s.duration, luma: sum / (px.length / 4) });
    s.close();
  }
  const chunks: { timestamp: number; data: Float32Array }[] = [];
  let audioEnd = 0;
  let sampleRate = SAMPLE_RATE;
  // Where the PACKETS put the sound, not where the decoder stamps it: Chrome's decoder closes every
  // hole in a track (audioTimeline.ts), and a reading through it would hide the very drift it is
  // here to see. Chunk k is packet k's (the decoder emits one per packet, checked below).
  const packetTimes: number[] = [];
  for await (const p of new mb.EncodedPacketSink(aTrack).packets(undefined, undefined, {
    metadataOnly: true,
  })) {
    packetTimes.push(p.timestamp);
  }
  for await (const s of new mb.AudioSampleSink(aTrack).samples()) {
    const data = new Float32Array(s.numberOfFrames);
    s.copyTo(data, { planeIndex: 0, format: 'f32-planar' });
    const at = packetTimes[chunks.length] ?? s.timestamp;
    chunks.push({ timestamp: at, data });
    sampleRate = s.sampleRate;
    audioEnd = Math.max(audioEnd, at + s.duration);
    s.close();
  }
  input.dispose();
  if (chunks.length !== packetTimes.length) {
    throw new Error(`${chunks.length} decoded chunks for ${packetTimes.length} audio packets`);
  }
  return {
    frames,
    onsets: audioOnsets(chunks, sampleRate),
    audioEnd,
    audioHoles: audioHoleCount(
      chunks.map((c) => ({ timestamp: c.timestamp, duration: c.data.length / sampleRate }))
    ),
  };
}

/** One row: make, prepare, read both, judge both. */
async function runCase(c: Case) {
  const made = await makeSource(c);
  // Holes: packets 20-29 of every 94 left out (a beep is in packets 0-1 of each second, never there).
  const source = c.audioHoles
    ? await remuxAudio(made, (n, p) => (n % 94 < 20 || n % 94 >= 30 ? p.timestamp : null))
    : c.audioDrift
      ? await remuxAudio(made, (n, p) => (n === 0 ? p.timestamp : (n * 1029) / SAMPLE_RATE))
      : made;
  const logs: string[] = [];
  const debug = console.debug;
  const warn = console.warn;
  console.debug = (...a: unknown[]) => {
    logs.push(a.map(String).join(' '));
    debug(...a);
  };
  console.warn = (...a: unknown[]) => {
    logs.push(a.map(String).join(' '));
    warn(...a);
  };
  try {
    const prepared = await prepareVideoForUpload(source, { trimToVideo: c.trimToVideo ?? false });
    const before = await read(source);
    const after = await read(prepared.file);
    const sourceGaps = before.frames.map((f, i) =>
      i ? f.timestamp - before.frames[i - 1].timestamp : 0
    );
    return {
      name: c.name,
      logs: logs.filter((l) => /audio:|plan:|hole/.test(l)),
      source: {
        audioHoles: before.audioHoles,
        frames: before.frames.length,
        maxFrameGapMs: Math.round(Math.max(...sourceGaps) * 1000),
        gapsOver60ms: sourceGaps.filter((g) => g > 0.06).length,
      },
      output: { frames: after.frames.length, type: prepared.file.type },
      verdict: judge({ ...after, seconds: c.seconds }),
    };
  } finally {
    console.debug = debug;
    console.warn = warn;
  }
}

Object.assign(window, { runCase });
document.title = 'ready';
