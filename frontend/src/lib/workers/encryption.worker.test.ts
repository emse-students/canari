import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The E2E worker itself, loaded as a module in the test's global scope: its `self.onmessage` and
 * `onrtctransform` are driven directly, and what it posts back is read from a spy on
 * `self.postMessage`. Each test loads a FRESH copy, because the worker's counters are module state.
 */

type Posted = { type: string; count?: number; detail?: string; counters?: unknown };
type Scope = typeof self & {
  onrtctransform: ((event: Event) => void) | null;
};

let posted: Posted[];

beforeEach(() => {
  posted = [];
  vi.spyOn(self, 'postMessage').mockImplementation(((msg: Posted) => {
    posted.push(msg);
  }) as typeof self.postMessage);
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function loadWorker() {
  await import('./encryption.worker');
  const scope = self as Scope;
  const send = (data: unknown) =>
    (self.onmessage as (e: MessageEvent) => Promise<void>)({ data, origin: '' } as MessageEvent);
  return { scope, send };
}

/** Runs `frames` through a transform of `side` and waits until the stream has drained. */
async function runTransform(
  scope: Scope,
  side: 'sender' | 'receiver',
  frames: unknown[],
  kind: string | null = 'audio'
) {
  const readable = new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(f);
      controller.close();
    },
  });
  const out: unknown[] = [];
  let finished!: () => void;
  const done = new Promise<void>((r) => (finished = r));
  const writable = new WritableStream({
    write: (f) => {
      out.push(f);
    },
    close: () => finished(),
  });
  scope.onrtctransform?.({
    transformer: { readable, writable, options: { side, kind } },
  } as unknown as Event);
  await done;
  return out;
}

/**
 * The `setKeys` message of one end of a call: two distinct keys, the caller sending with the one
 * the callee receives with - the shape `utils/callKeys.ts` derives.
 */
function keysFor(role: 'caller' | 'callee') {
  const callerKey = new Uint8Array(32).fill(1).buffer;
  const calleeKey = new Uint8Array(32).fill(2).buffer;
  return role === 'caller'
    ? { type: 'setKeys', send: callerKey, receive: calleeKey }
    : { type: 'setKeys', send: calleeKey, receive: callerKey };
}

const counters = () => posted.filter((p) => p.type === 'counters').at(-1)?.counters;

describe('the encryption worker', () => {
  it('answers getCounters with its exact totals', async () => {
    const { send } = await loadWorker();
    await send({ type: 'getCounters' });
    expect(counters()).toEqual({ encFrames: 0, decFrames: 0, decFail: 0, keyframesIn: 0 });
  });

  it('counts a frame too short for an IV as a decrypt failure', async () => {
    const { scope, send } = await loadWorker();
    await send(keysFor('caller'));

    await runTransform(scope, 'receiver', [{ data: new Uint8Array(4).buffer }]);
    await send({ type: 'getCounters' });

    expect(counters()).toMatchObject({ decFrames: 0, decFail: 1 });
  });

  /** One frame through the CALLER's worker, sealed; the worker's state is discarded afterwards. */
  async function sealAsCaller(frame: { data: ArrayBuffer }) {
    const { scope, send } = await loadWorker();
    await send(keysFor('caller'));
    const [sealed] = (await runTransform(scope, 'sender', [frame])) as { data: ArrayBuffer }[];
    vi.resetModules();
    return sealed.data;
  }

  it("opens at the other end what one end's worker sealed", async () => {
    const clear = new Uint8Array([9, 8, 7]);
    const sealed = await sealAsCaller({ data: clear.slice().buffer });
    expect(new Uint8Array(sealed)).not.toEqual(clear);

    const { scope, send } = await loadWorker();
    await send(keysFor('callee'));
    const [opened] = (await runTransform(scope, 'receiver', [{ data: sealed }])) as {
      data: ArrayBuffer;
    }[];
    expect(new Uint8Array(opened.data)).toEqual(clear);
    await send({ type: 'getCounters' });
    expect(counters()).toMatchObject({ decFrames: 1, decFail: 0 });
  });

  it('does not open a frame reflected back to the worker that sealed it', async () => {
    const sealed = await sealAsCaller({ data: new Uint8Array([1, 2, 3]).buffer });

    const { scope, send } = await loadWorker();
    await send(keysFor('caller'));
    const out = await runTransform(scope, 'receiver', [{ data: sealed }]);

    expect(out).toHaveLength(0);
    await send({ type: 'getCounters' });
    expect(counters()).toMatchObject({ decFrames: 0, decFail: 1 });
  });

  it('does not open an audio frame on a video receiver', async () => {
    const sealed = await sealAsCaller({ data: new Uint8Array([1, 2, 3]).buffer });

    const { scope, send } = await loadWorker();
    await send(keysFor('callee'));
    const out = await runTransform(scope, 'receiver', [{ data: sealed }], 'video');

    expect(out).toHaveLength(0);
    await send({ type: 'getCounters' });
    expect(counters()).toMatchObject({ decFrames: 0, decFail: 1 });
  });

  it("takes the kind from the page's transform options, never from the frame's class name", async () => {
    const sealed = await sealAsCaller({ data: new Uint8Array([1, 2, 3]).buffer });
    // A frame whose class NAME says video, on the audio receiver it was sealed for: it opens.
    class RTCEncodedVideoFrame {
      constructor(public data: ArrayBuffer) {}
    }

    const { scope, send } = await loadWorker();
    await send(keysFor('callee'));
    const out = await runTransform(scope, 'receiver', [new RTCEncodedVideoFrame(sealed)], 'audio');

    expect(out).toHaveLength(1);
  });

  it('forwards nothing, and says so, on a transform that carries no media kind', async () => {
    const { scope, send } = await loadWorker();
    await send(keysFor('caller'));

    const out = await runTransform(scope, 'sender', [{ data: new Uint8Array([1]).buffer }], null);

    expect(out).toHaveLength(0);
    expect(
      posted.some((p) => p.type === 'warn' && p.detail?.includes('without a media kind'))
    ).toBe(true);
    await send({ type: 'getCounters' });
    expect(counters()).toMatchObject({ encFrames: 0 });
  });

  it('reports transform errors sampled - the first three, then every 100th - never one per frame', async () => {
    const { scope, send } = await loadWorker();
    await send(keysFor('caller'));
    const broken = {
      get data(): ArrayBuffer {
        throw new Error('frame unreadable');
      },
    };

    await runTransform(
      scope,
      'sender',
      Array.from({ length: 250 }, () => broken)
    );

    const errors = posted.filter((p) => p.type === 'transformError');
    expect(errors.map((e) => e.count)).toEqual([1, 2, 3, 100, 200]);
    expect(errors[0].detail).toContain('frame unreadable');
  });
});
