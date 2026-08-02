import {
  markAwaitingHistory,
  clearAwaitingHistory,
  enumerateAwaitingHistory,
  isAwaitingHistory,
} from './awaitingHistoryRegistry';

describe('awaitingHistoryRegistry', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });

  it('marks a group awaiting, idempotently', () => {
    markAwaitingHistory('user-a', 'g1', 'no-local-history');
    markAwaitingHistory('user-a', 'g1', 'no-local-history');
    expect(enumerateAwaitingHistory('user-a')).toEqual(['g1']);
  });

  it('clears a marker', () => {
    markAwaitingHistory('user-a', 'g1', 'no-local-history');
    clearAwaitingHistory('user-a', 'g1');
    expect(enumerateAwaitingHistory('user-a')).toEqual([]);
  });

  it('scopes markers per user', () => {
    markAwaitingHistory('user-a', 'g1', 'no-local-history');
    markAwaitingHistory('user-a', 'g2', 'no-local-history');
    markAwaitingHistory('user-b', 'g3', 'no-local-history'); // other user - must be excluded
    expect(enumerateAwaitingHistory('user-a').sort()).toEqual(['g1', 'g2']);
    expect(enumerateAwaitingHistory('user-b')).toEqual(['g3']);
  });

  it('keeps the earliest instant across repeated marks (stable give-up horizon)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    markAwaitingHistory('user-a', 'g1', 'no-local-history');
    vi.setSystemTime(2_000_000);
    markAwaitingHistory('user-a', 'g1', 'no-local-history'); // must not reset the instant
    // 31 days after the FIRST mark: entry is expired and pruned on enumeration.
    vi.setSystemTime(1_000_000 + 31 * 24 * 60 * 60 * 1000);
    expect(enumerateAwaitingHistory('user-a')).toEqual([]);
    expect(localStorage.getItem('mls_awaiting_history_since:user-a:g1')).toBeNull();
  });

  it('retains a fresh marker below the give-up horizon', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    markAwaitingHistory('user-a', 'g1', 'no-local-history');
    vi.setSystemTime(1_000_000 + 29 * 24 * 60 * 60 * 1000);
    expect(enumerateAwaitingHistory('user-a')).toEqual(['g1']);
  });

  it('upgrades a presumption to a proof, and never the other way round', () => {
    markAwaitingHistory('user-a', 'g1', 'no-local-history');
    markAwaitingHistory('user-a', 'g1', 'unreadable-frames');
    markAwaitingHistory('user-a', 'g1', 'no-local-history'); // must not erase the proof
    expect(JSON.parse(localStorage.getItem('mls_awaiting_history_since:user-a:g1')!).reason).toBe(
      'unreadable-frames'
    );
  });

  it('ignores and prunes a legacy marker, which carries no evidence', () => {
    // Written by the join-time solicitation, which marked on the mere fact of rejoining.
    localStorage.setItem('mls_awaiting_history_since:user-a:g1', String(Date.now()));
    expect(isAwaitingHistory('user-a', 'g1')).toBe(false);
    expect(enumerateAwaitingHistory('user-a')).toEqual([]);
    expect(localStorage.getItem('mls_awaiting_history_since:user-a:g1')).toBeNull();
  });

  describe('isAwaitingHistory', () => {
    it('is false for an unmarked group, and per user', () => {
      markAwaitingHistory('user-a', 'g1', 'no-local-history');
      expect(isAwaitingHistory('user-a', 'g1')).toBe(true);
      expect(isAwaitingHistory('user-a', 'g2')).toBe(false);
      expect(isAwaitingHistory('user-b', 'g1')).toBe(false);
    });

    it('is false once cleared', () => {
      markAwaitingHistory('user-a', 'g1', 'no-local-history');
      clearAwaitingHistory('user-a', 'g1');
      expect(isAwaitingHistory('user-a', 'g1')).toBe(false);
    });

    it('is false past the give-up horizon - we stopped waiting, so our store is authoritative', () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      markAwaitingHistory('user-a', 'g1', 'no-local-history');
      vi.setSystemTime(1_000_000 + 29 * 24 * 60 * 60 * 1000);
      expect(isAwaitingHistory('user-a', 'g1')).toBe(true);
      vi.setSystemTime(1_000_000 + 31 * 24 * 60 * 60 * 1000);
      expect(isAwaitingHistory('user-a', 'g1')).toBe(false);
    });
  });
});
