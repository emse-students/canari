// @vitest-environment happy-dom
/**
 * The web catch-up's snapshot is never overtaken by a send that was already past the gate, and the
 * catch-up never waits on a frame that holds the MLS mutex.
 *
 * Seen 2026-11-24 on a new web device: 17 `[MLS] catch-up (<group>) state DISCARDED: the live client
 * was mutated N time(s) since the snapshot` in one restore. `createDecryptSession` took the MLS lock,
 * closed the send gate and snapshotted, while a send that had passed the gate just before had not
 * encrypted yet; its encrypt landed after the snapshot and the swap was refused. The catch-up now
 * takes the lock, closes the gate, waits out the sends between the gate and their encrypt, and only
 * then snapshots.
 */
vi.mock('../workers/mlsKeyPackage.worker?worker', () => ({ default: class {} }));

const workerSession = {
  decryptPage: vi.fn(async (msgs: Uint8Array[]) => msgs.map(() => ({ ok: true }))),
  finalize: vi.fn(async () => new Uint8Array([7])),
  dispose: vi.fn(),
};
vi.mock('$lib/mls-client/mlsCryptoWorkerSession', () => ({
  createMlsCryptoWorkerSession: vi.fn(async () => workerSession),
}));
vi.mock('$lib/mls-client/mlsStatePersisterRegistry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/mls-client/mlsStatePersisterRegistry')>()),
  scheduleOutboundMlsPersist: vi.fn(),
}));
vi.mock('$lib/mls-client/sendRatchetLedger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/mls-client/sendRatchetLedger')>()),
  noteFrameEmitted: vi.fn(async () => {}),
}));
vi.mock('$lib/mls-client/stateAuthority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/mls-client/stateAuthority')>()),
  refusesCommitsHere: () => false,
  lostLeadSinceLoad: () => false,
}));

import { WebMlsService } from './WebMlsService';
import { DELIVERY } from '$lib/mls-client/frameDelivery';
import { sealedFrame } from '$lib/mls-client/test/sealedFrame';

/** Everything the live client and the network saw, in order - the assertion subject. */
const trace: string[] = [];

/** Lets every pending continuation run; no clock involved. */
async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

/** A promise the test resolves by hand, to park a step of the send. */
function held<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function makeService(): { svc: WebMlsService; raw: Record<string, unknown> } {
  const svc = new WebMlsService();
  const raw = svc as unknown as Record<string, unknown>;
  raw.deviceId = 'web-u-dev';
  raw.client = {
    save_state: () => {
      trace.push('snapshot');
      return new Uint8Array([1]);
    },
    send_authored_message_bytes: () => {
      trace.push('encrypt');
      return { ciphertext: sealedFrame(3, 'g1'), authorProof: new Uint8Array([4]) };
    },
  };
  raw.delivery = {
    postApplicationMessage: async () => {
      trace.push('post');
      return 1;
    },
  };
  raw.groupsWithPendingCommit = async () => [];
  raw.freshEpoch = async () => 3;
  raw.reloadClientFromPlainState = async () => {
    trace.push('install');
    return true;
  };
  return { svc, raw };
}

/** Runs one page through the session and finishes it, as `history.ts` does. */
async function runCatchUp(
  opening: Promise<{
    decryptPage: (m: Uint8Array[]) => Promise<unknown>;
    finish: () => Promise<void>;
  }>
) {
  const session = await opening;
  await session.decryptPage([new Uint8Array([5])]);
  await session.finish();
}

describe('WebMlsService.createDecryptSession - the sends around a catch-up', () => {
  let warn: { mock: { calls: unknown[][] } };
  const discarded = () =>
    warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('state DISCARDED'));
  beforeEach(() => {
    trace.length = 0;
    vi.stubGlobal('Worker', class {});
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('a send past the gate, burning before its encrypt, is encrypted before the snapshot - no DISCARDED', async () => {
    const { svc, raw } = makeService();
    // An owed burn parks the send INSIDE the counted window: past the gate, before the encrypt.
    raw.owedSendBurns = new Map([['g1', new Map([[3, 2]])]]);
    const burn = held<number>();
    raw.skipSendGenerations = () => {
      trace.push('burn');
      return burn.promise;
    };
    const send = svc.sendMessage('g1', new Uint8Array([9]), undefined, DELIVERY.transport);
    await flush();
    expect(trace).toEqual(['burn']);

    const opening = svc.createDecryptSession('g1');
    await flush();
    // The send it would race has not encrypted yet, so the snapshot is not taken yet.
    expect(trace).toEqual(['burn']);

    burn.resolve(2);
    await send;
    await runCatchUp(opening);

    expect(trace).toEqual(['burn', 'encrypt', 'post', 'snapshot', 'install']);
    expect(discarded()).toEqual([]);
  });

  it('a send still settling (before the gate) is not waited for: it encrypts after the install - no DISCARDED', async () => {
    const { svc, raw } = makeService();
    const settle = held<string[]>();
    raw.groupsWithPendingCommit = () => settle.promise;
    const send = svc.sendMessage('g1', new Uint8Array([9]), undefined, DELIVERY.transport);
    await flush();

    const opening = svc.createDecryptSession('g1');
    await flush();
    expect(trace).toEqual(['snapshot']);
    settle.resolve([]);
    await flush();
    // It met the gate the catch-up closed, and waits there.
    expect(trace).toEqual(['snapshot']);

    await runCatchUp(opening);
    await send;
    expect(trace).toEqual(['snapshot', 'install', 'encrypt', 'post']);
    expect(discarded()).toEqual([]);
  });

  /**
   * THE DEADLOCK REVIEW FOUND IN THE FIRST VERSION OF THIS FIX (#4083): the drain awaits a send
   * under the MLS mutex (a key group's seed answer, `answerSeedRequest`). A catch-up that closed the
   * gate BEFORE taking the lock waited for that mutex while the frame holding it waited at the gate.
   */
  it('a frame holding the MLS mutex and awaiting a send while a catch-up starts: both complete', async () => {
    const { svc, raw } = makeService();
    const scheduler = raw.messageScheduler as { acquireMlsLock: () => Promise<() => void> };
    const releaseFrame = await scheduler.acquireMlsLock();

    const opening = svc.createDecryptSession('g1');
    await flush();
    let sent = false;
    const send = svc
      .sendMessage('g1', new Uint8Array([9]), undefined, DELIVERY.transport)
      .then(() => (sent = true));
    await flush();
    expect(sent).toBe(true);
    releaseFrame();

    await send;
    await runCatchUp(opening);
    expect(trace).toEqual(['encrypt', 'post', 'snapshot', 'install']);
    expect(discarded()).toEqual([]);
  });

  it("a frame borrowing a commit's loan awaits a send while a catch-up waits for the mutex: all three complete", async () => {
    const { svc, raw } = makeService();
    const scheduler = raw.messageScheduler as {
      runCommitUnderMlsLock: <T>(g: string, fn: () => Promise<T>) => Promise<T>;
      lendMlsLockWhile: <T>(g: string, work: () => Promise<T>) => Promise<T>;
      acquireMlsLockForFrame: (key: string) => Promise<(() => void) | null>;
    };
    const network = held<void>();
    let borrowed = false;
    let sent = false;
    // A commit of ANOTHER group holds the mutex and lends it while its request is on the network.
    const commit = scheduler.runCommitUnderMlsLock('g-commit', () =>
      scheduler.lendMlsLockWhile('g-commit', async () => {
        // A frame of g1 borrows the loan and awaits a send inline, as a seed answer does.
        const releaseFrame = await scheduler.acquireMlsLockForFrame('g1');
        borrowed = releaseFrame !== null;
        await svc.sendMessage('g1', new Uint8Array([9]), undefined, DELIVERY.transport);
        sent = true;
        releaseFrame?.();
        await network.promise;
      })
    );
    await flush();
    const opening = svc.createDecryptSession('g1');
    await flush();
    expect(borrowed).toBe(true);
    expect(sent).toBe(true);
    // The catch-up has not taken the mutex: the commit still holds it.
    expect(trace).toEqual(['encrypt', 'post']);

    network.resolve();
    await commit;
    await runCatchUp(opening);
    expect(trace).toEqual(['encrypt', 'post', 'snapshot', 'install']);
    expect(discarded()).toEqual([]);
  });
});
