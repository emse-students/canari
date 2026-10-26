import {
  closeStateLedgers,
  hydrateStateLedgers,
  readStateLedger,
  resetStateLedgersForTests,
  restageStateLedgers,
  restageWholeStateLedgerView,
  stageStateLedger,
  stateLedgerKeys,
  stateLedgersHydrated,
  takeStagedStateLedgers,
} from './stateLedgers';

/**
 * The view of the ledgers the MLS state carries, and the batch the next checkpoint writes into it.
 * The property defended: a value reaches the state ONLY through a checkpoint, and nothing staged
 * against one copy of the state survives the opening of another.
 */
const U = 'user-view';

beforeEach(() => {
  resetStateLedgersForTests();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('stateLedgers', () => {
  it('answers what the opened state carries, and a staged value at once', () => {
    hydrateStateLedgers(U, { a: '1' });
    stageStateLedger(U, 'b', '2');

    expect(readStateLedger(U, 'a')).toBe('1');
    expect(readStateLedger(U, 'b')).toBe('2');
    expect(takeStagedStateLedgers(U)).toEqual({ b: '2' });
    expect(takeStagedStateLedgers(U)).toBeUndefined();
  });

  it('stages a removal as null, and reads it as absent', () => {
    hydrateStateLedgers(U, { a: '1' });
    stageStateLedger(U, 'a', null);

    expect(readStateLedger(U, 'a')).toBeUndefined();
    expect(takeStagedStateLedgers(U)).toEqual({ a: null });
  });

  it('refuses, loudly, to read or stage before the state opened', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    stageStateLedger(U, 'a', '1');

    expect(readStateLedger(U, 'a')).toBeUndefined();
    expect(takeStagedStateLedgers(U)).toBeUndefined();
    expect(error).toHaveBeenCalledTimes(2);
  });

  it('drops what was staged against the previous copy of the state when another opens', () => {
    hydrateStateLedgers(U, {});
    stageStateLedger(U, 'a', '1');
    closeStateLedgers(U);

    expect(stateLedgersHydrated(U)).toBe(false);
    hydrateStateLedgers(U, { b: '2' });
    expect(takeStagedStateLedgers(U)).toBeUndefined();
    expect(readStateLedger(U, 'a')).toBeUndefined();
  });

  it('restages a failed batch with the CURRENT value, never the stale one', () => {
    hydrateStateLedgers(U, {});
    stageStateLedger(U, 'a', '1');
    stageStateLedger(U, 'b', '1');
    const failed = takeStagedStateLedgers(U)!;
    stageStateLedger(U, 'a', '2'); // moved while the failed write ran

    restageStateLedgers(U, failed);

    expect(takeStagedStateLedgers(U)).toEqual({ a: '2', b: '1' });
  });

  it('restages the whole view for a fresh state, but what it is told to leave out', () => {
    hydrateStateLedgers(U, { 'seen:g': '[]', 'send-persisted': '{}' });

    restageWholeStateLedgerView(U, ['send-persisted']);

    expect(takeStagedStateLedgers(U)).toEqual({ 'seen:g': '[]' });
  });

  it('lists keys by prefix, and keeps two accounts apart', () => {
    hydrateStateLedgers(U, { 'seen:a': '[]', 'seen:b': '[]', other: 'x' });
    hydrateStateLedgers('user-2', { 'seen:c': '[]' });

    expect(stateLedgerKeys(U, 'seen:')).toEqual(['seen:a', 'seen:b']);
    expect(stateLedgerKeys('user-2', 'seen:')).toEqual(['seen:c']);
  });
});
