// @vitest-environment happy-dom
/**
 * A CHECKPOINT MAKES THE RATCHET DURABLE, SO IT MUST MAKE THE REPLAY'S MARKS DURABLE TOO.
 *
 * The archive replay returns a commit thunk the caller runs AFTER the encrypted checkpoint, which
 * stops the ledger running ahead of the persisted ratchet. The converse was unguarded: a checkpoint
 * landing DURING the walk - and one lands on any structural mutation, because
 * `flushEncryptedInternal` is not gated by the bulk-ingest depth - made the ratchet durable while the
 * marks were still only in memory. A page killed there reloads with a ratchet ahead of its ledger and
 * re-accuses frames it really did read, on the loudest line the client has.
 *
 * Measured on TAB-3b (2026-09-07) and proved by INSERTION ORDER rather than by inference: the set
 * serialises as `[...set]`, so position is insertion order, and all six accused row keys sat at the
 * very END of a 3 511-entry set - written by the last run while accusing them. Two whole runs had
 * therefore written nothing durable, while the generations they consumed stayed consumed.
 *
 * The first case below is the one that fails on the old behaviour, and it is deliberately written as
 * the sequence a kill would interrupt rather than as a call to the new function on its own.
 */
vi.mock('$lib/utils/chat/historyReconcile', () => ({
  escalateReconciliation: vi.fn().mockResolvedValue(true),
}));

import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';
import { frameFingerprint } from '$lib/mls-client/inboundFrameLedger';
import { toBase64 } from '$lib/utils/hex';
import {
  commitPendingHistoryMarks,
  markHistoryFrameConsumed,
  replayConversationHistory,
  resetSeenCipherCacheForTests,
  snapshotPendingHistoryMarks,
} from './history';

const USER = 'user-ckpt';
const GROUP = 'group-ckpt';
const KEY = `history_seen_cipher:${USER}:${GROUP}`;

const wire = new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55]);
const row = {
  id: '1786655250946-0',
  sender_id: 'peer',
  content: toBase64(wire),
  timestamp: String(1786655250946),
};

/** What a later page load would find - the only thing that survives the kill this is all about. */
const durable = (): string[] => JSON.parse(localStorage.getItem(KEY) ?? '[]');

/** Lets the live path's coalesced microtask drain, so a case cannot mistake it for the fix. */
const flush = () => Promise.resolve().then(() => undefined);

/** A checkpoint whose write lands at once: the snapshot, then the declaration. */
const checkpoint = (userId: string = USER) =>
  commitPendingHistoryMarks(snapshotPendingHistoryMarks(userId));

/** Drives one replay page and hands back its commit thunk, exactly as the caller would receive it. */
const replayOnePage = async (
  result: { ok: boolean; plaintext?: null; error?: string },
  page: typeof row = row
) => {
  const mlsService = createMlsServiceStub({
    getLocalGroups: vi.fn().mockReturnValue([GROUP]),
    createDecryptSession: vi.fn().mockResolvedValue({
      decryptPage: vi.fn().mockResolvedValue([result]),
      finish: vi.fn().mockResolvedValue(undefined),
    }),
    fetchHistory: vi.fn().mockResolvedValue({ rows: [] }),
  });
  return replayConversationHistory({
    mlsService,
    id: GROUP,
    contactName: 'peer',
    userId: USER,
    deviceKey: () => 'device-key',
    storage: null,
    getConversation: () => undefined,
    setConversation: () => undefined,
    messageReactions: new Map(),
    log: () => undefined,
    primedFirstPage: { rows: [page] },
  });
};

beforeEach(() => {
  localStorage.clear();
  resetSeenCipherCacheForTests();
  vi.clearAllMocks();
});

describe('marks the replay has made but not committed', () => {
  it('are NOT durable on their own - the premise, and the reason the thunk exists', async () => {
    // The replay must not persist as it goes: a mark durable before the ratchet that justifies it
    // would SKIP the frame on reload, which is the unsurvivable direction.
    await replayOnePage({ ok: true, plaintext: null });
    await flush();

    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('ARE made durable by a checkpoint, with no thunk run at all - the fix', async () => {
    // This is the case that fails on the old behaviour. `persistCheckpoint` calls
    // `commitPendingHistoryMarks` right after its write lands, so a checkpoint that fires mid-walk
    // carries the marks accumulated up to it. Before this, the walk could be interrupted after a
    // checkpoint and leave the ratchet durable with the ledger empty.
    await replayOnePage({ ok: true, plaintext: null });

    checkpoint();

    expect(durable()).toContain(frameFingerprint(wire));
  });

  it('a mark made WHILE the checkpoint writes waits for the next one', async () => {
    // The native checkpoint releases the manager once it has exported (2026-10-13), and the web
    // one seals in a worker: a page can decrypt and mark between the export and the write landing.
    // That mark's ratchet advance is not in the file being written, so declaring it would make the
    // ledger durable ahead of the ratchet - the direction that skips a frame for good.
    await replayOnePage({ ok: true, plaintext: null });
    const snapshot = snapshotPendingHistoryMarks(USER); // the checkpoint starts: export follows

    const later = new Uint8Array([0x66, 0x77, 0x88, 0x99]);
    await replayOnePage(
      { ok: true, plaintext: null },
      { ...row, id: '1786655250947-0', content: toBase64(later), timestamp: '1786655250947' }
    );
    commitPendingHistoryMarks(snapshot); // the write lands

    expect(durable()).toContain(frameFingerprint(wire));
    expect(durable()).not.toContain(frameFingerprint(later));

    checkpoint(); // and the next checkpoint, which does hold it, declares it
    expect(durable()).toContain(frameFingerprint(later));
  });

  it('never takes back a mark a LATER checkpoint made durable while this one wrote', async () => {
    // Checkpoints are not all serialised (the watchdog and the registry call `persistCheckpoint`
    // directly), so a second one can start AND land between this one's snapshot and its commit.
    // A frame read live in between is then ALREADY durable when the late commit lands; writing the
    // older snapshot verbatim over it would erase that mark and re-accuse a frame this device read.
    await replayOnePage({ ok: true, plaintext: null });
    const snapshot = snapshotPendingHistoryMarks(USER);

    const live = new Uint8Array([0xaa, 0xbb, 0xcc]);
    markHistoryFrameConsumed(USER, GROUP, frameFingerprint(live));
    checkpoint(); // the later checkpoint, start to finish
    expect(durable()).toContain(frameFingerprint(live)); // the premise: the live mark is durable
    // Marked again after it, so the late commit below takes its merge path, not the clean one.
    await replayOnePage(
      { ok: true, plaintext: null },
      { ...row, id: '1786655250948-0', content: toBase64(new Uint8Array([1, 2])), timestamp: '1' }
    );
    commitPendingHistoryMarks(snapshot);

    expect(durable()).toContain(frameFingerprint(wire));
    expect(durable()).toContain(frameFingerprint(live));
  });

  it('are NOT written by the thunk - the checkpoint that precedes it is their one writer', async () => {
    // The "no checkpoint fired" case is gone: `withMlsBulkIngest` runs the thunk only after a
    // checkpoint that covers the walk, and withholds it when there is none. The thunk keeps the
    // cursor and the retry counters; the marks are the checkpoint's.
    const commit = await replayOnePage({ ok: true, plaintext: null });
    commit?.();
    await flush();

    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('a LIVE mark made while the covering checkpoint seals is not made durable by the thunk', async () => {
    // The exact ordering of the defect: the replay ends, checkpoint Y starts (its snapshot), a live
    // COMMIT is decrypted and marked while Y seals - its epoch is NOT in Y's file - then Y lands and
    // the thunk runs. The thunk used to write the shared LIVE set, so the commit's fingerprint became
    // durable before checkpoint Z that holds its epoch; a kill before Z then skipped the commit on
    // the cold replay, and every later frame failed `wrong-epoch`.
    const commit = await replayOnePage({ ok: true, plaintext: null });
    const y = snapshotPendingHistoryMarks(USER); // Y starts
    const liveCommit = new Uint8Array([0xc0, 0xff, 0xee]);
    markHistoryFrameConsumed(USER, GROUP, frameFingerprint(liveCommit)); // while Y seals
    commitPendingHistoryMarks(y); // Y lands
    commit?.(); // the helper runs the thunk now
    await flush();

    expect(durable()).toContain(frameFingerprint(wire));
    expect(durable()).not.toContain(frameFingerprint(liveCommit));

    checkpoint(); // Z, which holds the commit's epoch, declares it
    expect(durable()).toContain(frameFingerprint(liveCommit));
  });

  it('belong to their own account - a checkpoint for somebody else writes nothing', async () => {
    await replayOnePage({ ok: true, plaintext: null });

    checkpoint('a-different-user');

    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('drain once - a second checkpoint with nothing new in between rewrites nothing', async () => {
    await replayOnePage({ ok: true, plaintext: null });
    checkpoint();
    const setItem = vi.spyOn(localStorage, 'setItem');

    checkpoint();

    expect(setItem.mock.calls.filter(([k]) => k === KEY)).toHaveLength(0);
    setItem.mockRestore();
  });

  it('does not write a set the replay never touched', () => {
    // Registering at the top of the walk instead of at the mark would make every checkpoint rewrite
    // a set capped at five thousand entries, for nothing.
    checkpoint();

    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
