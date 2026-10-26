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
import {
  hydrateStateLedgers,
  resetStateLedgersForTests,
  STATE_LEDGER,
  takeStagedStateLedgers,
  type StateLedgerChanges,
} from '$lib/mls-client/stateLedgers';
import { toBase64 } from '$lib/utils/hex';
import {
  markHistoryFrameConsumed,
  replayConversationHistory,
  resetSeenCipherCacheForTests,
  stagePendingHistoryMarks,
} from './history';

const USER = 'user-ckpt';
const GROUP = 'group-ckpt';
const KEY = STATE_LEDGER.seen(GROUP);

const wire = new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55]);
const row = {
  id: '1786655250946-0',
  sender_id: 'peer',
  content: toBase64(wire),
  timestamp: String(1786655250946),
};

/**
 * The MLS state on disk: what the platform's checkpoint wrote, ledgers included. The only thing that
 * survives the kill this file is about.
 */
let disk: Map<string, string>;

/** What a later page load would find in the state. */
const durable = (): string[] => JSON.parse(disk.get(KEY) ?? '[]');

/** Lets the live path's coalesced microtask drain, so a case cannot mistake it for the fix. */
const flush = () => Promise.resolve().then(() => undefined);

/** A checkpoint STARTS: the marks are staged and taken, as `persistCheckpoint` does before the export. */
const checkpointStarts = (userId: string = USER): StateLedgerChanges | undefined => {
  stagePendingHistoryMarks(userId);
  return takeStagedStateLedgers(userId);
};

/** The checkpoint's ONE write lands: the state and the ledgers it carries, together. */
const writeLands = (changes: StateLedgerChanges | undefined): void => {
  for (const [key, value] of Object.entries(changes ?? {})) {
    if (value === null) disk.delete(key);
    else disk.set(key, value);
  }
};

/** A checkpoint whose write lands at once. */
const checkpoint = (userId: string = USER) => writeLands(checkpointStarts(userId));

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
  disk = new Map();
  resetSeenCipherCacheForTests();
  resetStateLedgersForTests();
  hydrateStateLedgers(USER, {});
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('marks the replay has made but not committed', () => {
  it('are NOT durable on their own - the premise, and the reason the thunk exists', async () => {
    // The replay must not persist as it goes: a mark durable before the ratchet that justifies it
    // would SKIP the frame on reload, which is the unsurvivable direction.
    await replayOnePage({ ok: true, plaintext: null });
    await flush();

    expect(disk.has(KEY)).toBe(false);
  });

  it('ARE carried by a checkpoint, with no thunk run at all', async () => {
    // A checkpoint that fires mid-walk carries the marks accumulated up to it - in the SAME write as
    // the ratchet advance they describe (KILL-2, 2026-10-26).
    await replayOnePage({ ok: true, plaintext: null });

    checkpoint();

    expect(durable()).toContain(frameFingerprint(wire));
  });

  it('a mark made AFTER the checkpoint staged waits for the next one', async () => {
    // The native checkpoint releases the manager once it has exported (2026-10-13), and the web one
    // seals in a worker: a page can decrypt and mark between the staging and the write landing. That
    // mark's ratchet advance is not in the state being written, so it must not ride in it.
    await replayOnePage({ ok: true, plaintext: null });
    const staged = checkpointStarts();

    const later = new Uint8Array([0x66, 0x77, 0x88, 0x99]);
    await replayOnePage(
      { ok: true, plaintext: null },
      { ...row, id: '1786655250947-0', content: toBase64(later), timestamp: '1786655250947' }
    );
    writeLands(staged);

    expect(durable()).toContain(frameFingerprint(wire));
    expect(durable()).not.toContain(frameFingerprint(later));

    checkpoint(); // and the next checkpoint, which does hold it, carries it
    expect(durable()).toContain(frameFingerprint(later));
  });

  it('are NOT written by the thunk - the checkpoint that precedes it is their one writer', async () => {
    // `withMlsBulkIngest` runs the thunk only after a checkpoint that covers the walk, and withholds
    // it when there is none. The thunk keeps the cursor and the retry counters; the marks are the
    // checkpoint's.
    const commit = await replayOnePage({ ok: true, plaintext: null });
    commit?.();
    await flush();

    expect(stagePendingHistoryMarks(USER)).toBe(1); // still pending: only a checkpoint takes them
    expect(disk.has(KEY)).toBe(false);
  });

  it('a LIVE mark made while the covering checkpoint seals rides the NEXT checkpoint', async () => {
    // The ordering of the 2026-10-17 defect: the replay ends, checkpoint Y stages, a live COMMIT is
    // decrypted and marked while Y seals - its epoch is NOT in Y's state - then Y lands and the thunk
    // runs. Its fingerprint must reach the disk only with checkpoint Z, which holds its epoch.
    const commit = await replayOnePage({ ok: true, plaintext: null });
    const y = checkpointStarts();
    const liveCommit = new Uint8Array([0xc0, 0xff, 0xee]);
    markHistoryFrameConsumed(USER, GROUP, frameFingerprint(liveCommit)); // while Y seals
    writeLands(y);
    commit?.();
    await flush();

    expect(durable()).toContain(frameFingerprint(wire));
    expect(durable()).not.toContain(frameFingerprint(liveCommit));

    checkpoint(); // Z
    expect(durable()).toContain(frameFingerprint(liveCommit));
  });

  it('belong to their own account - a checkpoint for somebody else carries nothing', async () => {
    await replayOnePage({ ok: true, plaintext: null });
    hydrateStateLedgers('a-different-user', {});

    expect(checkpointStarts('a-different-user')).toBeUndefined();
  });

  it('drain once - a second checkpoint with nothing new in between stages nothing', async () => {
    await replayOnePage({ ok: true, plaintext: null });
    checkpoint();

    expect(checkpointStarts()).toBeUndefined();
  });

  it('does not stage a set the replay never touched', () => {
    // Registering at the top of the walk instead of at the mark would make every checkpoint rewrite
    // a set capped at five thousand entries, for nothing.
    expect(checkpointStarts()).toBeUndefined();
  });
});
