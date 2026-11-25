// @vitest-environment happy-dom
/**
 * The web catch-up's snapshot is never overtaken by a send that was already past the gate.
 *
 * Seen 2026-11-24 on a new web device: 17 `[MLS] catch-up (<group>) state DISCARDED: the live client
 * was mutated N time(s) since the snapshot` in one restore. `createDecryptSession` took the MLS lock,
 * closed the send gate and snapshotted; a send that had passed the gate just before was still
 * settling, encrypted after the snapshot, and the swap was refused - the worker's ratchet advance and
 * its decrypt work thrown away. The catch-up now closes the gate, waits those sends out, and only
 * then takes the lock and snapshots.
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

function makeService(): { svc: WebMlsService; settle: (groups: string[]) => void } {
  const svc = new WebMlsService();
  let settle!: (groups: string[]) => void;
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
  // The send asks for kept commits and is held there: past the gate, before its encrypt.
  raw.groupsWithPendingCommit = () => new Promise<string[]>((resolve) => (settle = resolve));
  raw.reloadClientFromPlainState = async () => {
    trace.push('install');
    return true;
  };
  return { svc, settle: (groups) => settle(groups) };
}

describe('WebMlsService.createDecryptSession - the sends already past the gate', () => {
  let warn: { mock: { calls: unknown[][] } };
  beforeEach(() => {
    trace.length = 0;
    vi.stubGlobal('Worker', class {});
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('snapshots only after a parked send encrypted, and installs its state without a DISCARDED line', async () => {
    const { svc, settle } = makeService();
    const send = svc.sendMessage('g1', new Uint8Array([9]), undefined, DELIVERY.transport);
    for (let i = 0; i < 5; i++) await Promise.resolve();

    const opening = svc.createDecryptSession('g1');
    for (let i = 0; i < 10; i++) await Promise.resolve();
    // The send it would race has not encrypted yet, so the snapshot is not taken yet.
    expect(trace).toEqual([]);

    settle([]);
    await send;
    const session = await opening;
    await session.decryptPage([new Uint8Array([5])]);
    await session.finish();

    expect(trace).toEqual(['encrypt', 'post', 'snapshot', 'install']);
    const discarded = warn.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('state DISCARDED')
    );
    expect(discarded).toEqual([]);
  });
});
