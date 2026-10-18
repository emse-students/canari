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
async function runTransform(scope: Scope, side: 'sender' | 'receiver', frames: unknown[]) {
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
    transformer: { readable, writable, options: { side } },
  } as unknown as Event);
  await done;
  return out;
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
    await send({ type: 'setKey', payload: new Uint8Array(32).fill(1).buffer });

    await runTransform(scope, 'receiver', [{ data: new Uint8Array(4).buffer }]);
    await send({ type: 'getCounters' });

    expect(counters()).toMatchObject({ decFrames: 0, decFail: 1 });
  });

  it('round-trips a frame: what the sender seals, the receiver opens', async () => {
    const { scope, send } = await loadWorker();
    await send({ type: 'setKey', payload: new Uint8Array(32).fill(1).buffer });
    const clear = new Uint8Array([9, 8, 7]);

    const [sealed] = (await runTransform(scope, 'sender', [{ data: clear.slice().buffer }])) as {
      data: ArrayBuffer;
    }[];
    expect(new Uint8Array(sealed.data)).not.toEqual(clear);
    const [opened] = (await runTransform(scope, 'receiver', [{ data: sealed.data }])) as {
      data: ArrayBuffer;
    }[];
    expect(new Uint8Array(opened.data)).toEqual(clear);

    await send({ type: 'getCounters' });
    expect(counters()).toMatchObject({ encFrames: 1, decFrames: 1, decFail: 0 });
  });

  it('reports transform errors sampled - the first three, then every 100th - never one per frame', async () => {
    const { scope, send } = await loadWorker();
    await send({ type: 'setKey', payload: new Uint8Array(32).fill(1).buffer });
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
