// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import { closeMlsDb } from '$lib/utils/hex';
import { noteFrameEmitted, readEmitted } from './sendRatchetLedger';
import { adoptLegacyLedgers } from './stateLedgerMigration';
import {
  hydrateStateLedgers,
  readStateLedger,
  resetStateLedgersForTests,
  STATE_LEDGER,
  STATE_LEDGER_FORMAT,
  takeStagedStateLedgers,
} from './stateLedgers';

/**
 * THE ONE PASS THAT MOVES AN OLDER CLIENT'S `localStorage` LEDGERS INTO THE MLS STATE.
 *
 * What it must not do is lose a count or a mark on the way (an under-burn re-issues a generation, a
 * lost mark re-accuses a frame), nor leave two sources of one fact alive: the old copies go, but only
 * once a state that carries the ledgers has been OPENED - a kill before the first checkpoint lands
 * leaves them for the next opening to migrate again.
 */
const U = 'user-mig';

beforeEach(async () => {
  localStorage.clear();
  await closeMlsDb();
  globalThis.indexedDB = new IDBFactory();
  resetStateLedgersForTests();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** Writes the ledgers exactly as a client before 2026-10-26 left them. */
function seedLegacy(): void {
  localStorage.setItem(ACCOUNT_KEY.seenCipher(U, 'g1'), JSON.stringify(['1:a', '1786-0']));
  localStorage.setItem(ACCOUNT_KEY.seenCipher(U, 'g2'), JSON.stringify(['2:b']));
  localStorage.setItem(ACCOUNT_KEY.seenCipherIndex(U), JSON.stringify(['g2', 'g1', 'gone']));
  localStorage.setItem(
    ACCOUNT_KEY.sendRatchetLedger(U),
    JSON.stringify({ emitted: { 'g1@4': 5 }, persisted: { 'g1@4': 3 } })
  );
}

describe('adoptLegacyLedgers', () => {
  it('stages every old mark and count into the state, and moves `emitted` to its own store', async () => {
    seedLegacy();
    hydrateStateLedgers(U, {});

    expect(await adoptLegacyLedgers(U)).toBe('migrated');

    expect(await readEmitted(U)).toEqual({ 'g1@4': 5 });
    expect(takeStagedStateLedgers(U)).toEqual({
      [STATE_LEDGER.sendPersisted]: JSON.stringify({ 'g1@4': 3 }),
      [STATE_LEDGER.seen('g1')]: JSON.stringify(['1:a', '1786-0']),
      [STATE_LEDGER.seen('g2')]: JSON.stringify(['2:b']),
      // An index entry naming a ledger the state does not hold is dropped, not carried.
      [STATE_LEDGER.seenIndex]: JSON.stringify(['g2', 'g1']),
      [STATE_LEDGER.format]: STATE_LEDGER_FORMAT,
    });
  });

  it('keeps the old copies until a state carrying the format is opened - a kill re-migrates', async () => {
    seedLegacy();
    hydrateStateLedgers(U, {});
    await adoptLegacyLedgers(U);
    // The kill: the checkpoint that would have carried the staging never landed.
    hydrateStateLedgers(U, {});

    expect(localStorage.getItem(ACCOUNT_KEY.seenCipher(U, 'g1'))).not.toBeNull();
    expect(await adoptLegacyLedgers(U)).toBe('migrated');
    expect(readStateLedger(U, STATE_LEDGER.seen('g1'))).toBe(JSON.stringify(['1:a', '1786-0']));
  });

  it('never lowers an `emitted` count the new store already holds', async () => {
    seedLegacy();
    hydrateStateLedgers(U, {});
    await adoptLegacyLedgers(U);
    // A send after the first pass, then a kill before its checkpoint: the second pass must not
    // write the older, smaller count over it.
    await noteFrameEmitted(U, 'g1', 4);
    hydrateStateLedgers(U, {});
    await adoptLegacyLedgers(U);

    expect(await readEmitted(U)).toEqual({ 'g1@4': 6 });
  });

  it('deletes the old copies once the opened state carries the ledgers, and reads none of them', async () => {
    seedLegacy();
    hydrateStateLedgers(U, {
      [STATE_LEDGER.format]: STATE_LEDGER_FORMAT,
      [STATE_LEDGER.seen('g1')]: JSON.stringify(['1:a', '1786-0', '9:z']),
    });

    expect(await adoptLegacyLedgers(U)).toBe('swept');

    expect(localStorage.length).toBe(0);
    expect(takeStagedStateLedgers(U)).toBeUndefined();
    expect(await readEmitted(U)).toEqual({});
  });

  it('keeps a seen ledger the state already holds over the old copy', async () => {
    seedLegacy();
    hydrateStateLedgers(U, { [STATE_LEDGER.seen('g1')]: JSON.stringify(['newer']) });

    await adoptLegacyLedgers(U);

    expect(takeStagedStateLedgers(U)).not.toHaveProperty(STATE_LEDGER.seen('g1'));
    expect(readStateLedger(U, STATE_LEDGER.seen('g1'))).toBe(JSON.stringify(['newer']));
  });

  it("touches nothing of another account's", async () => {
    localStorage.setItem(ACCOUNT_KEY.seenCipher('other', 'g1'), '["x"]');
    hydrateStateLedgers(U, { [STATE_LEDGER.format]: STATE_LEDGER_FORMAT });

    expect(await adoptLegacyLedgers(U)).toBe('nothing');
    expect(localStorage.getItem(ACCOUNT_KEY.seenCipher('other', 'g1'))).toBe('["x"]');
  });

  it('marks a fresh state as carrying the format, with nothing to move', async () => {
    hydrateStateLedgers(U, {});

    expect(await adoptLegacyLedgers(U)).toBe('nothing');
    expect(takeStagedStateLedgers(U)).toEqual({ [STATE_LEDGER.format]: STATE_LEDGER_FORMAT });
  });

  it('skips an unreadable old ledger, says so, and migrates the rest', async () => {
    localStorage.setItem(ACCOUNT_KEY.seenCipher(U, 'g1'), 'not json');
    localStorage.setItem(ACCOUNT_KEY.seenCipher(U, 'g2'), '["2:b"]');
    hydrateStateLedgers(U, {});

    await adoptLegacyLedgers(U);

    expect(console.warn).toHaveBeenCalled();
    expect(readStateLedger(U, STATE_LEDGER.seen('g1'))).toBeUndefined();
    expect(readStateLedger(U, STATE_LEDGER.seen('g2'))).toBe('["2:b"]');
  });
});
