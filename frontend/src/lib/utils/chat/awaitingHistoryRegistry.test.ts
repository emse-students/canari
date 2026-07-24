import {
  markAwaitingHistory,
  clearAwaitingHistory,
  enumerateAwaitingHistory,
} from './awaitingHistoryRegistry';

describe('awaitingHistoryRegistry', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });

  it('marks a group awaiting, idempotently', () => {
    markAwaitingHistory('user-a', 'g1');
    markAwaitingHistory('user-a', 'g1');
    expect(enumerateAwaitingHistory('user-a')).toEqual(['g1']);
  });

  it('clears a marker', () => {
    markAwaitingHistory('user-a', 'g1');
    clearAwaitingHistory('user-a', 'g1');
    expect(enumerateAwaitingHistory('user-a')).toEqual([]);
  });

  it('scopes markers per user', () => {
    markAwaitingHistory('user-a', 'g1');
    markAwaitingHistory('user-a', 'g2');
    markAwaitingHistory('user-b', 'g3'); // other user - must be excluded
    expect(enumerateAwaitingHistory('user-a').sort()).toEqual(['g1', 'g2']);
    expect(enumerateAwaitingHistory('user-b')).toEqual(['g3']);
  });

  it('keeps the earliest instant across repeated marks (stable give-up horizon)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    markAwaitingHistory('user-a', 'g1');
    vi.setSystemTime(2_000_000);
    markAwaitingHistory('user-a', 'g1'); // must not reset the instant
    // 31 days after the FIRST mark: entry is expired and pruned on enumeration.
    vi.setSystemTime(1_000_000 + 31 * 24 * 60 * 60 * 1000);
    expect(enumerateAwaitingHistory('user-a')).toEqual([]);
    expect(localStorage.getItem('mls_awaiting_history_since:user-a:g1')).toBeNull();
  });

  it('retains a fresh marker below the give-up horizon', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    markAwaitingHistory('user-a', 'g1');
    vi.setSystemTime(1_000_000 + 29 * 24 * 60 * 60 * 1000);
    expect(enumerateAwaitingHistory('user-a')).toEqual(['g1']);
  });
});
