/**
 * THE BROADCASTER'S PIPELINE: recorder chunk -> fragments -> self-contained segment -> seal ->
 * the uploader's queue, IN ORDER (WP-L5). Pure orchestration: the seal and the queue are injected,
 * so it is tested without a recorder, a key or a network.
 *
 * ORDER IS THE WHOLE CONTRACT. The ingest is gapless and the AAD of a sealed segment binds its index,
 * so the index a segment is sealed with MUST be the one the uploader sends it as. Chunks are taken
 * one at a time through one promise chain - a chunk's `arrayBuffer()` and its seal are asynchronous,
 * and two in flight could finish out of order - and the index is READ from the queue
 * (`nextIndex`), sealed for and enqueued with; the queue refuses any other, and this keeps no
 * second counter. A retry is the queue's and re-sends the SAME sealed bytes: nothing is re-sealed.
 *
 * A GENERATION is one recorder: its own init, its own splitter, its own time offset. A camera
 * re-acquired after a background starts a new one ({@link LiveSegmentPipeline.beginGeneration}); the
 * old recorder's last chunk, pushed before, is still processed with the old generation.
 *
 * Logging: per segment nothing but a debug line; a summary every {@link SUMMARY_EVERY} segments
 * (`[LIVE-PIPE] summary`), and one line per anomaly. Never a key or a segment's bytes.
 */

import {
  Fmp4ParseError,
  Fmp4Splitter,
  composeSegment,
  rebaseFragment,
  type Fmp4Init,
} from './fmp4Segments';

/** A summary line every this many segments (30 s at 2 s segments). */
export const SUMMARY_EVERY = 15;

/** What the pipeline needs from the outside. */
export interface LiveSegmentPipelineDeps {
  /** Seals one plaintext segment for `index` (the live's key and id are bound by the caller). */
  seal: (index: number, plain: Uint8Array<ArrayBuffer>) => Promise<Uint8Array<ArrayBuffer>>;
  /**
   * The index the queue takes next (`LiveSegmentUploader.nextIndex`) - THE one counter: a segment is
   * sealed for it and enqueued with it, and the pipeline keeps no copy.
   */
  nextIndex: () => number;
  /** Queues a sealed segment AT that index (`LiveSegmentUploader.enqueue`; throws on another). */
  enqueue: (index: number, sealed: Uint8Array<ArrayBuffer>) => void;
  /** The server's largest segment (`segmentMaxBytes`): a larger one is not sent, it is reported. */
  maxSegmentBytes: number;
  /** A monotonic clock in ms, for the seal timing in the summary. */
  now: () => number;
}

/** Counters of the whole live, read by the summary line and the tests. */
export interface LivePipelineStats {
  segments: number;
  plainBytes: number;
  /** Fragments whose video did not start on a sync sample (WP-L1 measured none). */
  notOnKeyframe: number;
  /** Fragments not sent: over the size limit, a parse failure, a seal that threw. */
  dropped: number;
  /** Chunks that held more than one fragment (14 % on Android in WP-L1). */
  multiFragmentChunks: number;
  sealMsTotal: number;
}

interface Generation {
  id: number;
  splitter: Fmp4Splitter;
  offsetMs: number;
  init: Fmp4Init | null;
  /** A parse failure poisons the generation: its bytes cannot be framed any more. */
  broken: boolean;
}

export class LiveSegmentPipeline {
  readonly stats: LivePipelineStats = {
    segments: 0,
    plainBytes: 0,
    notOnKeyframe: 0,
    dropped: 0,
    multiFragmentChunks: 0,
    sealMsTotal: 0,
  };
  #tail: Promise<void> = Promise.resolve();
  #generation: Generation | null = null;
  #generations = 0;
  #closed = false;

  constructor(private readonly deps: LiveSegmentPipelineDeps) {}

  /**
   * A new recorder starts: its chunks are read with their own init, and its media time is shifted
   * by `offsetMs` (0 for the first recorder; the time since the live began for a re-acquired one).
   */
  beginGeneration(offsetMs: number): void {
    const id = ++this.#generations;
    console.debug(`[LIVE-PIPE] generation ${id} begins at +${Math.round(offsetMs)} ms`);
    this.#generation = {
      id,
      splitter: new Fmp4Splitter(),
      offsetMs,
      init: null,
      broken: false,
    };
  }

  /** Takes one recorder chunk; resolves once it is sealed and queued (or dropped, and logged). */
  push(chunk: Blob | Uint8Array): Promise<void> {
    const generation = this.#generation;
    if (!generation) {
      console.error('[LIVE-PIPE] a chunk arrived before any generation began - dropped');
      return Promise.resolve();
    }
    const run = this.#tail.then(() => this.#process(generation, chunk));
    // The chain never rejects: #process logs and counts its own failures.
    this.#tail = run;
    return run;
  }

  /** Resolves once every chunk pushed so far has been sealed and queued. */
  flush(): Promise<void> {
    return this.#tail;
  }

  /** Nothing more is queued (the live ended); chunks still in the chain are dropped. */
  close(): void {
    this.#closed = true;
  }

  async #process(generation: Generation, chunk: Blob | Uint8Array): Promise<void> {
    if (this.#closed || generation.broken) return;
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(await chunk.arrayBuffer());
    if (bytes.byteLength === 0) return;
    let split;
    try {
      split = generation.splitter.push(bytes);
    } catch (e) {
      // A recorder whose output cannot be framed cannot be resynchronised from the middle: the
      // generation stops producing, LOUDLY. The live goes on air again at the next re-acquire.
      generation.broken = true;
      this.stats.dropped++;
      const why = e instanceof Fmp4ParseError ? e.message : String(e);
      console.error(`[LIVE-PIPE] generation ${generation.id}: unreadable recorder output (${why})`);
      return;
    }
    if (split.init) {
      generation.init = split.init;
      console.debug(
        `[LIVE-PIPE] generation ${generation.id}: init ${split.init.bytes.byteLength} B, video track ${split.init.videoTrackId ?? 'none'}`
      );
    }
    if (split.fragments.length > 1) this.stats.multiFragmentChunks++;
    for (const raw of split.fragments) {
      if (this.#closed) return;
      await this.#send(generation, raw);
    }
  }

  async #send(
    generation: Generation,
    raw: { bytes: Uint8Array; startsOnKeyframe: boolean | null }
  ): Promise<void> {
    const init = generation.init!;
    let plain: Uint8Array<ArrayBuffer>;
    try {
      plain = composeSegment(init, rebaseFragment(raw, init, generation.offsetMs));
    } catch (e) {
      this.stats.dropped++;
      console.error(`[LIVE-PIPE] a fragment could not be rebased - not sent`, e);
      return;
    }
    if (raw.startsOnKeyframe === false) {
      this.stats.notOnKeyframe++;
      console.warn(
        `[LIVE-PIPE] segment ${this.deps.nextIndex()} does not start on a keyframe - a viewer joining on it waits for the next`
      );
    }
    // Read now and used for both: the queue has one producer (this chain), so it cannot move between.
    const index = this.deps.nextIndex();
    const sealStart = this.deps.now();
    let sealed: Uint8Array<ArrayBuffer>;
    try {
      sealed = await this.deps.seal(index, plain);
    } catch (e) {
      this.stats.dropped++;
      console.error(`[LIVE-PIPE] segment ${index} could not be sealed - not sent`, e);
      return;
    }
    if (this.#closed) return;
    this.stats.sealMsTotal += this.deps.now() - sealStart;
    if (sealed.byteLength > this.deps.maxSegmentBytes) {
      // The server would answer 413 and the uploader would stop the whole live on it: one
      // oversized segment is a gap in the picture, not the end of the broadcast.
      this.stats.dropped++;
      console.error(
        `[LIVE-PIPE] segment ${index} is ${sealed.byteLength} B, over the server's ${this.deps.maxSegmentBytes} - not sent`
      );
      return;
    }
    try {
      this.deps.enqueue(index, sealed);
    } catch (e) {
      // A stopped queue (the server's verdict already ended the live) or an index the queue did not
      // expect: nothing after it can be sent either, so the pipeline closes.
      this.#closed = true;
      this.stats.dropped++;
      console.error(`[LIVE-PIPE] segment ${index} refused by the queue - pipeline closed`, e);
      return;
    }
    this.stats.segments++;
    this.stats.plainBytes += plain.byteLength;
    console.debug(`[LIVE-PIPE] segment ${index} queued`);
    if (this.stats.segments % SUMMARY_EVERY === 0) this.#summary();
  }

  #summary(): void {
    const s = this.stats;
    console.log(
      `[LIVE-PIPE] summary: ${s.segments} segments, ${(s.plainBytes / 1e6).toFixed(1)} MB, ` +
        `seal ${(s.sealMsTotal / s.segments).toFixed(1)} ms avg, two-fragment chunks ${s.multiFragmentChunks}, ` +
        `not on keyframe ${s.notOnKeyframe}, dropped ${s.dropped}, generation ${this.#generations}`
    );
  }
}
