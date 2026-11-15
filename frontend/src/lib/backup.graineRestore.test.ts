// happy-dom ships no IndexedDB: the real backend, as `graineStore.test.ts` runs it.
import 'fake-indexeddb/auto';
import { exportBackup, importBackup } from './backup';
import { formatRecoveryCode, generateRecoveryCodeBytes } from './crypto/backupRecoveryCode';
import { IndexedDbStorage } from './db/indexeddb';
import type { StoredGraineSession } from './db/types';
import type { GraineRunReading } from './mls-client/IMlsService';
import { reserveOutboundSlot } from './utils/graine/sessionManager';

/**
 * A backup never brings back a session to SEAL under (channel-encryption section 21.3).
 *
 * The index of the next message is `firstIndex + sentCount`, and the count is only true on the
 * store that has kept it since the mint. A backup's count is the one at export: every message this
 * device sealed afterwards is behind it. Restored as an outbound session after a wipe, it would
 * hand those indices out a second time - a second message under a key already used - whenever the
 * key group's run still matched the session's anchor (the MLS state restored from the same file).
 */

vi.mock('$lib/wasm/mls_wasm.js', () => ({
  decrypt_with_key: () => {
    throw new Error('not a v2 file');
  },
}));

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
const NOW = 1_700_000_000_000;
/** The key group's run, the SAME at export and after the restore: the MLS state came back with it. */
const RUN: GraineRunReading = { runId: 'run-A', epoch: 4, epochFingerprint: 'fp-4' };
const SCOPE = { workspaceId: 'ws-1', channelId: 'chan-1', senderId: 'alice' };
const FRAME = { groupId: 'dist-group', protoB64: 'ZnJhbWU=' };
const V2 = {
  minterDeviceId: 'dev-a',
  signingPublicKeyB64: 'cGs=',
  endorsementB64: 'ZW5k',
  signingSecretKeyB64: 'c2s=',
};

/** A session this device minted, every field an outbound one carries, `sent` messages in. */
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

let counter = 0;
async function freshStorage(): Promise<IndexedDbStorage> {
  const storage = new IndexedDbStorage(`graine-restore-${counter++}`);
  await storage.init();
  return storage;
}

function deps(storage: IndexedDbStorage) {
  return {
    storage,
    deviceKeyB64: KEY,
    distributionEpoch: RUN.epoch,
    readRun: vi.fn().mockResolvedValue(RUN),
    distribute: vi.fn().mockResolvedValue(FRAME),
    endorse: vi.fn().mockResolvedValue(V2),
    now: () => NOW,
  };
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('a Graine session restored from a backup', () => {
  it('is never sealed under again: the first send after the restore mints a new session', async () => {
    // Exported at 3 sent, then 4 more sealed (indices 3..6), then the device was wiped.
    const before = await freshStorage();
    await before.saveGraineSession(outbound(3), KEY);
    const code = generateRecoveryCodeBytes();
    const file = await exportBackup(before, 'alice', KEY, 'device-1', undefined, code);
    await before.saveGraineSession(outbound(7), KEY);

    const after = await freshStorage();
    await importBackup(file, KEY, after, 'device-1', formatRecoveryCode(code));

    const d = deps(after);
    const slot = await reserveOutboundSlot(d, SCOPE);

    expect(slot.minted).toBe(true);
    expect(slot.session.sessionId).not.toBe('sess-outbound');
    expect(slot.index).toBe(0);
    expect(d.distribute).toHaveBeenCalledTimes(1);
  });

  it('still opens what it always opened: the seed is kept, as a session this device reads', async () => {
    const before = await freshStorage();
    await before.saveGraineSession(outbound(3), KEY);
    const code = generateRecoveryCodeBytes();
    const file = await exportBackup(before, 'alice', KEY, 'device-1', undefined, code);

    const after = await freshStorage();
    await importBackup(file, KEY, after, 'device-1', formatRecoveryCode(code));

    const restored = await after.getGraineSession('sess-outbound', KEY);
    expect(restored?.seedB64).toBe(outbound(3).seedB64);
    expect(restored?.firstIndex).toBe(0);
    expect(restored?.v2?.signingPublicKeyB64).toBe(V2.signingPublicKeyB64);
    // What makes a session this device's OUTBOUND one is gone with the count it can no longer trust.
    expect(restored?.sentCount).toBeUndefined();
  });

  it('leaves a session the device still holds exactly as it is: its live count wins', async () => {
    const live = await freshStorage();
    await live.saveGraineSession(outbound(3), KEY);
    const code = generateRecoveryCodeBytes();
    const file = await exportBackup(live, 'alice', KEY, 'device-1', undefined, code);
    await live.saveGraineSession(outbound(7), KEY);

    await importBackup(file, KEY, live, 'device-1', formatRecoveryCode(code));

    const slot = await reserveOutboundSlot(deps(live), SCOPE);
    expect(slot.minted).toBe(false);
    expect(slot.index).toBe(7);
  });
});
