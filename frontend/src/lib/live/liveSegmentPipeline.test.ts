/**
 * THE PIPELINE'S ORDER: every segment is sealed for the index the queue takes next and enqueued
 * with it, in chunk order, whatever the seal's timing - and a re-acquired camera's chunks go out
 * with their own init and a shifted media time, on the same index sequence.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveSegmentPipeline, MAX_CONSECUTIVE_DROPS, SUMMARY_EVERY } from './liveSegmentPipeline';
import { fragment, initSegment, join, readTimes } from './fmp4.test-helper';

/** A queue with the uploader's contract: one counter, any other index refused. */
class FakeQueue {
  next: number;
  readonly items: { index: number; sealed: Uint8Array }[] = [];
  stopped = false;
  constructor(start = 0) {
    this.next = start;
  }
  enqueue = (index: number, sealed: Uint8Array<ArrayBuffer>) => {
    if (this.stopped) throw new Error('stopped');
    if (index !== this.next) throw new RangeError(`enqueue(${index}) but next is ${this.next}`);
    this.next++;
    this.items.push({ index, sealed });
  };
}

/** A seal that tags its output with the index it was given, so the test reads what it sealed for. */
const tagSeal = vi.fn(async (index: number, plain: Uint8Array<ArrayBuffer>) => {
  const out = new Uint8Array(4 + plain.byteLength);
  new DataView(out.buffer).setUint32(0, index);
  out.set(plain, 4);
  return out;
});
const sealedFor = (sealed: Uint8Array) => new DataView(sealed.buffer).getUint32(0);
const plainOf = (sealed: Uint8Array) => sealed.slice(4);

function pipeline(
  queue: FakeQueue,
  overrides: Partial<ConstructorParameters<typeof LiveSegmentPipeline>[0]> = {}
) {
  return new LiveSegmentPipeline({
    seal: tagSeal,
    nextIndex: () => queue.next,
    enqueue: queue.enqueue,
    maxSegmentBytes: 4 * 1024 * 1024,
    now: () => 0,
    ...overrides,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  tagSeal.mockClear();
});

describe('LiveSegmentPipeline', () => {
  it('Android shape: the init-alone chunk queues nothing, then each fragment is a self-contained segment', async () => {
    const q = new FakeQueue();
    const p = pipeline(q);
    const g = p.beginGeneration(0);
    void p.push(g, initSegment());
    void p.push(g, fragment({ videoTime: 0n }));
    void p.push(g, fragment({ videoTime: 180_000n }));
    await p.flush();
    expect(q.items.map((i) => i.index)).toEqual([0, 1]);
    expect(q.items.map((i) => sealedFor(i.sealed))).toEqual([0, 1]);
    expect(plainOf(q.items[0].sealed)).toEqual(join(initSegment(), fragment({ videoTime: 0n })));
  });

  it("a two-fragment chunk becomes two segments on consecutive indexes, from the queue's own next index", async () => {
    const q = new FakeQueue(7);
    const p = pipeline(q);
    const g = p.beginGeneration(0);
    await p.push(
      g,
      join(initSegment(), fragment({ videoTime: 0n }), fragment({ videoTime: 180_000n }))
    );
    expect(q.items.map((i) => [i.index, sealedFor(i.sealed)])).toEqual([
      [7, 7],
      [8, 8],
    ]);
    expect(p.stats.multiFragmentChunks).toBe(1);
  });

  it('keeps chunk order when an earlier seal is the slower one', async () => {
    const q = new FakeQueue();
    let releaseFirst!: () => void;
    const seal = vi.fn(async (index: number, plain: Uint8Array<ArrayBuffer>) => {
      if (index === 0) await new Promise<void>((r) => (releaseFirst = r));
      return tagSeal(index, plain);
    });
    const p = pipeline(q, { seal });
    const g = p.beginGeneration(0);
    void p.push(g, initSegment());
    void p.push(g, fragment({ videoTime: 0n }));
    const last = p.push(g, fragment({ videoTime: 180_000n }));
    await vi.waitFor(() => expect(seal).toHaveBeenCalledTimes(1));
    // The second segment is not sealed while the first is still sealing.
    expect(q.items).toEqual([]);
    releaseFirst();
    await last;
    expect(
      q.items.map((i) => readTimes(plainOf(i.sealed).slice(initSegment().length)).video)
    ).toEqual([0n, 180_000n]);
  });

  it('a re-acquired camera: a new init, its media time shifted by the offset, the indexes continuing', async () => {
    const q = new FakeQueue();
    const p = pipeline(q);
    const g = p.beginGeneration(0);
    await p.push(g, join(initSegment(), fragment({ videoTime: 0n })));
    // The old recorder's last chunk, pushed before the new generation begins, keeps its own init.
    void p.push(g, fragment({ videoTime: 180_000n }));
    const g2 = p.beginGeneration(30_000);
    // iOS shape this time: init + media in the first chunk; the new recorder restarts at zero.
    await p.push(g2, join(initSegment(), fragment({ videoTime: 0n, audioTime: 0 })));
    expect(q.items.map((i) => i.index)).toEqual([0, 1, 2]);
    const third = plainOf(q.items[2].sealed);
    expect(third.slice(0, initSegment().length)).toEqual(initSegment());
    expect(readTimes(third.slice(initSegment().length))).toEqual({
      video: 30n * 90_000n,
      audio: 30 * 48_000,
    });
    expect(readTimes(plainOf(q.items[1].sealed).slice(initSegment().length)).video).toBe(180_000n);
  });

  it("a segment over the server's limit is reported and not sent; the next one still goes", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const q = new FakeQueue();
    const p = pipeline(q, { maxSegmentBytes: initSegment().length + 4 + 200 });
    const g = p.beginGeneration(0);
    await p.push(
      g,
      join(initSegment(), fragment({ mediaBytes: 500 }), fragment({ mediaBytes: 10 }))
    );
    expect(q.items).toHaveLength(1);
    expect(q.items[0].index).toBe(0);
    expect(p.stats.dropped).toBe(1);
  });

  it(`EVERY segment over the limit: after ${MAX_CONSECUTIVE_DROPS} in a row the generation breaks and the owner is told, once`, async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const q = new FakeQueue();
    const onBroken = vi.fn();
    const p = pipeline(q, { maxSegmentBytes: initSegment().length + 4 + 200, onBroken });
    const g = p.beginGeneration(0);
    await p.push(g, initSegment());
    for (let i = 0; i < MAX_CONSECUTIVE_DROPS + 2; i++) {
      await p.push(g, fragment({ mediaBytes: 500 }));
    }
    expect(q.items).toEqual([]);
    expect(onBroken).toHaveBeenCalledExactlyOnceWith(g);
    expect(p.stats.dropped).toBe(MAX_CONSECUTIVE_DROPS);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('in a row could not be sent'));
  });

  it('a seal that keeps throwing breaks the generation the same way', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const q = new FakeQueue();
    const onBroken = vi.fn();
    const p = pipeline(q, { seal: () => Promise.reject(new Error('OperationError')), onBroken });
    const g = p.beginGeneration(0);
    await p.push(g, join(initSegment(), fragment(), fragment(), fragment(), fragment()));
    expect(onBroken).toHaveBeenCalledExactlyOnceWith(g);
    expect(p.stats.dropped).toBe(MAX_CONSECUTIVE_DROPS);
  });

  it('drops that are not in a row never break the generation: a queued segment resets the count', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const q = new FakeQueue();
    const onBroken = vi.fn();
    const p = pipeline(q, { maxSegmentBytes: initSegment().length + 4 + 200, onBroken });
    const g = p.beginGeneration(0);
    await p.push(g, initSegment());
    for (let i = 0; i < 3; i++) {
      for (let d = 0; d < MAX_CONSECUTIVE_DROPS - 1; d++) {
        await p.push(g, fragment({ mediaBytes: 500 }));
      }
      await p.push(g, fragment({ mediaBytes: 10 }));
    }
    expect(onBroken).not.toHaveBeenCalled();
    expect(q.items).toHaveLength(3);
  });

  it('an unparseable chunk breaks its generation loudly and TELLS the owner; the next generation goes on air', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const q = new FakeQueue();
    const onBroken = vi.fn();
    const p = pipeline(q, { onBroken });
    const g = p.beginGeneration(0);
    await p.push(g, fragment()); // media before any init
    await p.push(g, join(initSegment(), fragment()));
    expect(q.items).toEqual([]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('unreadable recorder output'));
    expect(onBroken).toHaveBeenCalledExactlyOnceWith(g);
    const g2 = p.beginGeneration(10_000);
    await p.push(g2, join(initSegment(), fragment()));
    expect(q.items.map((i) => i.index)).toEqual([0]);
  });

  it('counts a fragment that does not start on a keyframe, and still sends it (the ingest is gapless)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const q = new FakeQueue();
    const p = pipeline(q);
    const g = p.beginGeneration(0);
    await p.push(g, join(initSegment(), fragment({ keyframe: false })));
    expect(q.items).toHaveLength(1);
    expect(p.stats.notOnKeyframe).toBe(1);
  });

  it('a queue that refuses (the live ended) closes the pipeline', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const q = new FakeQueue();
    q.stopped = true;
    const p = pipeline(q);
    const g = p.beginGeneration(0);
    await p.push(g, join(initSegment(), fragment(), fragment()));
    expect(tagSeal).toHaveBeenCalledTimes(1);
    expect(p.stats.dropped).toBe(1);
  });

  it(`logs one summary every ${SUMMARY_EVERY} segments, and never a segment's bytes`, async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const q = new FakeQueue();
    const p = pipeline(q);
    const g = p.beginGeneration(0);
    await p.push(g, initSegment());
    for (let i = 0; i < SUMMARY_EVERY * 2; i++) await p.push(g, fragment({ videoTime: BigInt(i) }));
    const summaries = log.mock.calls.filter((c) => String(c[0]).includes('summary'));
    expect(summaries).toHaveLength(2);
    for (const call of log.mock.calls) {
      for (const arg of call) expect(arg).not.toBeInstanceOf(Uint8Array);
    }
  });

  it('nothing is queued once closed', async () => {
    const q = new FakeQueue();
    const p = pipeline(q);
    const g = p.beginGeneration(0);
    p.close();
    await p.push(g, join(initSegment(), fragment()));
    expect(q.items).toEqual([]);
  });

  it('a Blob whose read REJECTS breaks its generation and tells the owner - the chain itself survives', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const q = new FakeQueue();
    const onBroken = vi.fn();
    const p = pipeline(q, { onBroken });
    const g = p.beginGeneration(0);
    const unreadable = { arrayBuffer: () => Promise.reject(new Error('NotReadableError')) } as Blob;
    await expect(p.push(g, unreadable)).resolves.toBeUndefined();
    expect(onBroken).toHaveBeenCalledExactlyOnceWith(g);
    // The same generation sends nothing more: its splitter missed bytes.
    await p.push(g, join(initSegment(), fragment()));
    expect(q.items).toEqual([]);
    // A new recorder is still served by the same chain.
    const g2 = p.beginGeneration(5_000);
    await p.push(g2, join(initSegment(), fragment()));
    expect(q.items.map((i) => i.index)).toEqual([0]);
  });

  it("the OLD recorder's last chunk, arriving after the new generation began, lands in the old splitter", async () => {
    const q = new FakeQueue();
    const p = pipeline(q);
    const g1 = p.beginGeneration(0);
    await p.push(g1, join(initSegment(), fragment({ videoTime: 0n })));
    const g2 = p.beginGeneration(30_000);
    await p.push(g2, join(initSegment(), fragment({ videoTime: 0n })));
    // Late: the old recorder's stop delivered its final chunk only now.
    await p.push(g1, fragment({ videoTime: 180_000n }));
    expect(
      q.items.map((i) => readTimes(plainOf(i.sealed).slice(initSegment().length)).video)
    ).toEqual([0n, 30n * 90_000n, 180_000n]);
  });

  it('ending a generation LOGS the bytes it still held, and a chunk pushed after is dropped loudly', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const q = new FakeQueue();
    const p = pipeline(q);
    const g = p.beginGeneration(0);
    const whole = join(initSegment(), fragment(), fragment());
    await p.push(g, whole.slice(0, whole.length - 10));
    expect(q.items).toHaveLength(1);
    await p.endGeneration(g);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/generation 1 ended with \d+ B never framed/)
    );
    await p.push(g, whole.slice(whole.length - 10));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('unknown or ended generation'));
    expect(q.items).toHaveLength(1);
    expect(p.stats.dropped).toBe(1);
  });
});
