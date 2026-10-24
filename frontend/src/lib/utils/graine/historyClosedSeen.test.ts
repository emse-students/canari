// @vitest-environment happy-dom
import { ACCOUNT_KEY } from '../accountLocalKeys';
import {
  beginHistoryWidening,
  forgetHistoryClosedSeen,
  noteHistoryClosed,
  settleHistoryWidening,
} from './historyClosedSeen';

/**
 * The durable record that turns a later `shared` into a widened history ask (2026-10-22). What is
 * worth pinning is the order of its states: a widening is seen as `first` exactly once (that is
 * when the answers given under the floor are forgotten), settled only from `widened`, and a past
 * closed again is never settled by an answer to an ask made while it was closed.
 */
describe('historyClosedSeen', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('owes nothing for a community whose past was never closed to this device', () => {
    expect(beginHistoryWidening('alice', 'ws-1')).toBe('none');
  });

  it('sees a widening FIRST once, then as continuing until it is settled', () => {
    noteHistoryClosed('alice', 'ws-1');
    expect(beginHistoryWidening('alice', 'ws-1')).toBe('first');
    expect(beginHistoryWidening('alice', 'ws-1')).toBe('continuing');
    expect(settleHistoryWidening('alice', 'ws-1')).toBe(true);
    expect(beginHistoryWidening('alice', 'ws-1')).toBe('none');
  });

  it('settles nothing while the past is still closed', () => {
    noteHistoryClosed('alice', 'ws-1');
    expect(settleHistoryWidening('alice', 'ws-1')).toBe(false);
    expect(beginHistoryWidening('alice', 'ws-1')).toBe('first');
  });

  it('a past closed again goes back to closed, and a later widening is FIRST again', () => {
    noteHistoryClosed('alice', 'ws-1');
    beginHistoryWidening('alice', 'ws-1');
    noteHistoryClosed('alice', 'ws-1');
    expect(beginHistoryWidening('alice', 'ws-1')).toBe('first');
  });

  it('is per account, and forgotten with the community', () => {
    noteHistoryClosed('alice', 'ws-1');
    expect(beginHistoryWidening('bob', 'ws-1')).toBe('none');
    forgetHistoryClosedSeen('alice', 'ws-1');
    expect(localStorage.getItem(ACCOUNT_KEY.historyClosedSeen('alice'))).toBeNull();
  });

  it('reads a malformed record as none, out loud', () => {
    localStorage.setItem(ACCOUNT_KEY.historyClosedSeen('alice'), '["ws-1"]');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(beginHistoryWidening('alice', 'ws-1')).toBe('none');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
