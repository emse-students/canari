// happy-dom ships no IndexedDB: the real backend, shared by name between the two "tabs" exactly as
// two documents of one origin share it.
import 'fake-indexeddb/auto';
import { IndexedDbStorage } from '$lib/db/indexeddb';
import { StoreWriteRefusedError, type StoredGraineSession } from '$lib/db/types';
import type { GraineRunReading } from '$lib/mls-client/IMlsService';

/**
 * Two tabs, one session store: an index is handed out once whatever the leadership says
 * (channel-encryption, WP-30: the orderings of `reserveOutboundSlot`).
 *
 * The reservation is a read-modify-write serialised only within its own document. Its write is
 * guarded by leadership (`mayWrite`), but leadership is read at the write: between a lock steal and
 * the rejection that tells it, a tab still believes it leads. Such a tab, resumed with the count it
 * read before the new leader sent, wrote that count back - and both tabs then sealed at indices
 * already used. The write is a compare-and-swap on `sentCount` in its own transaction instead, so
 * the overlap cannot land, whatever either tab believes.
 */

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
const NOW = 1_700_000_000_000;
const RUN: GraineRunReading = { runId: 'run-A', epoch: 4, epochFingerprint: 'fp-4' };
const SCOPE = { workspaceId: 'ws-1', channelId: 'chan-1', senderId: 'alice' };
const FRAME = { groupId: 'dist-group', protoB64: 'ZnJhbWU=' };
const V2 = {
  minterDeviceId: 'dev-a',
  signingPublicKeyB64: 'cGs=',
  endorsementB64: 'ZW5k',
  signingSecretKeyB64: 'c2s=',
};

/** The session the device minted, `sent` messages in, current at `RUN`. */
function outbound(sent: number): StoredGraineSession {
  return {
    ...SCOPE,
    sessionId: 'sess-outbound',
    seedB64: btoa(String.fromCharCode(...new Uint8Array(32).fill(1))),
    firstIndex: 0,
    createdAt: NOW,
    sentCount: sent,
    distributionEpoch: RUN.epoch,
    distributionFrame: FRAME,
    v2: V2,
    rotationAnchor: {
      runId: RUN.runId,
      epochFingerprint: RUN.epochFingerprint,
      redistributed: false,
    },
  };
}

/** One tab: its own copy of the manager (its own per-channel chain) over its own connection. */
async function tab(dbName: string) {
  vi.resetModules();
  const { reserveOutboundSlot } = await import('./sessionManager');
  const storage = new IndexedDbStorage(dbName);
  await storage.init();
  return { reserveOutboundSlot, storage };
}

function deps(storage: IndexedDbStorage, readRun: () => Promise<GraineRunReading>) {
  return {
    storage,
    deviceKeyB64: KEY,
    distributionEpoch: RUN.epoch,
    readRun,
    distribute: vi.fn().mockResolvedValue(FRAME),
    endorse: vi.fn().mockResolvedValue(V2),
    // BOTH tabs believe they lead: the stale one has not been told yet.
    mayWrite: () => true,
    now: () => NOW,
  };
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('a reservation resumed after another tab sent on the same session', () => {
  it('is refused, nothing written, and no index is handed out twice', async () => {
    const dbName = 'graine-two-tabs';
    const seed = new IndexedDbStorage(dbName);
    await seed.init();
    await seed.saveGraineSession(outbound(3), KEY);

    const stale = await tab(dbName);
    const leader = await tab(dbName);

    // The stale tab reads the count (3), then freezes inside the reservation.
    let resume!: () => void;
    const frozen = new Promise<void>((r) => (resume = r));
    let readIt!: () => void;
    const hasRead = new Promise<void>((r) => (readIt = r));
    const staleSlot = stale.reserveOutboundSlot(
      deps(stale.storage, async () => {
        readIt();
        await frozen;
        return RUN;
      }),
      SCOPE
    );
    await hasRead;

    // Meanwhile the new leader seals twice: indices 3 and 4.
    const handedOut: number[] = [];
    const leaderDeps = deps(leader.storage, async () => RUN);
    handedOut.push((await leader.reserveOutboundSlot(leaderDeps, SCOPE)).index);
    handedOut.push((await leader.reserveOutboundSlot(leaderDeps, SCOPE)).index);
    expect(handedOut).toEqual([3, 4]);

    // The stale tab resumes with the count it read before them.
    resume();
    await expect(staleSlot).rejects.toBeInstanceOf(StoreWriteRefusedError);

    // Nothing rolled back: the leader's next send continues where it stopped.
    handedOut.push((await leader.reserveOutboundSlot(leaderDeps, SCOPE)).index);
    expect(handedOut).toEqual([3, 4, 5]);
    expect((await seed.getGraineSession('sess-outbound', KEY))?.sentCount).toBe(6);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[GRAINE]'));
  });

  it('is written when nobody moved the count in between', async () => {
    const dbName = 'graine-two-tabs-quiet';
    const seed = new IndexedDbStorage(dbName);
    await seed.init();
    await seed.saveGraineSession(outbound(3), KEY);

    const only = await tab(dbName);
    const slot = await only.reserveOutboundSlot(
      deps(only.storage, async () => RUN),
      SCOPE
    );
    expect(slot.index).toBe(3);
    expect((await seed.getGraineSession('sess-outbound', KEY))?.sentCount).toBe(4);
    expect(console.error).not.toHaveBeenCalled();
  });
});
