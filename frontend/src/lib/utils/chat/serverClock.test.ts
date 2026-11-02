// @vitest-environment happy-dom
/**
 * The ceiling of this account's own server read marks survives the session that saw it, is shared
 * by the tabs of one origin, and is never another account's (review of #2824, B).
 */
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import { noteServerTime, resetServerClockForTests, serverTimeSeen } from './serverClock';
import { readMarkTarget } from './readState';
import type { ChatMessage } from '$lib/types';

const row = (id: string, serverAt: number): ChatMessage => ({
  id,
  senderId: 'peer',
  content: id,
  timestamp: new Date(serverAt - 100),
  serverTimestamp: serverAt,
  isOwn: false,
});

beforeEach(() => {
  localStorage.clear();
  resetServerClockForTests();
});

describe('serverClock', () => {
  it('an offline boot is bounded by what an earlier session was told', () => {
    noteServerTime('Alice', 5_000);
    resetServerClockForTests(); // the reload: memory is gone, the network is not back
    expect(serverTimeSeen('alice')).toBe(5_000);
    const msgs = [row('a', 4_000), row('b', 8_000)];
    expect(readMarkTarget(msgs, 0, false, serverTimeSeen('alice'))).toBe(5_000);
  });

  it('a follower tab that receives no frame is bounded by what the leader tab noted', () => {
    // This tab noted an old statement; the leader, same origin, noted a newer one since.
    noteServerTime('alice', 1_000);
    localStorage.setItem(ACCOUNT_KEY.serverClock('alice'), '9000');
    expect(serverTimeSeen('alice')).toBe(9_000);
  });

  it('only moves forward, ignores what is not a time, and is per account', () => {
    noteServerTime('alice', 5_000);
    noteServerTime('alice', 4_000);
    noteServerTime('alice', Number.NaN);
    noteServerTime('alice', undefined);
    expect(serverTimeSeen('alice')).toBe(5_000);
    expect(serverTimeSeen('bob')).toBe(0);
  });

  it('nothing known on this device: the server mark does not move', () => {
    expect(serverTimeSeen('alice')).toBe(0);
    expect(readMarkTarget([row('a', 4_000)], 300, false, serverTimeSeen('alice'))).toBe(300);
  });
});
