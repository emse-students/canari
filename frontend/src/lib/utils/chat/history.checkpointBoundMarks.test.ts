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
  replayConversationHistory,
  resetSeenCipherCacheForTests,
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

/** Drives one replay page and hands back its commit thunk, exactly as the caller would receive it. */
const replayOnePage = async (result: { ok: boolean; plaintext?: null; error?: string }) => {
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
    deviceKeyB64: 'device-key',
    storage: null,
    getConversation: () => undefined,
    setConversation: () => undefined,
    messageReactions: new Map(),
    log: () => undefined,
    primedFirstPage: { rows: [row] },
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

    commitPendingHistoryMarks(USER);

    expect(durable()).toContain(frameFingerprint(wire));
  });

  it('are still committed by the thunk when NO checkpoint fired during the walk', async () => {
    // The thunk is not replaced, it is the remaining case. A short walk that mutates nothing
    // structural never triggers a checkpoint, and its marks must still land.
    const commit = await replayOnePage({ ok: true, plaintext: null });
    commit?.();
    await flush();

    expect(durable()).toContain(frameFingerprint(wire));
  });

  it('belong to their own account - a checkpoint for somebody else writes nothing', async () => {
    await replayOnePage({ ok: true, plaintext: null });

    commitPendingHistoryMarks('a-different-user');

    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('drain once - a second checkpoint with nothing new in between rewrites nothing', async () => {
    await replayOnePage({ ok: true, plaintext: null });
    commitPendingHistoryMarks(USER);
    const setItem = vi.spyOn(localStorage, 'setItem');

    commitPendingHistoryMarks(USER);

    expect(setItem.mock.calls.filter(([k]) => k === KEY)).toHaveLength(0);
    setItem.mockRestore();
  });

  it('does not write a set the replay never touched', () => {
    // Registering at the top of the walk instead of at the mark would make every checkpoint rewrite
    // a set capped at five thousand entries, for nothing.
    commitPendingHistoryMarks(USER);

    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
