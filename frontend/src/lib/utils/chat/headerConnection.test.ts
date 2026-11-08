import { describe, expect, it } from 'vitest';
import { isHeaderConnected } from './headerConnection';

const base = { isWsConnected: false, isLoggedIn: true, isTabLeader: false, isOffline: false };

describe('isHeaderConnected', () => {
  it('is connected when the socket is open', () => {
    expect(isHeaderConnected({ ...base, isWsConnected: true, isTabLeader: true })).toBe(true);
  });
  it('a reachable follower tab is connected although it holds no socket', () => {
    expect(isHeaderConnected(base)).toBe(true);
  });
  it('an unreachable follower is offline', () => {
    expect(isHeaderConnected({ ...base, isOffline: true })).toBe(false);
  });
  it('a leader without its socket is offline', () => {
    expect(isHeaderConnected({ ...base, isTabLeader: true })).toBe(false);
  });
  it('a signed-out page is offline', () => {
    expect(isHeaderConnected({ ...base, isLoggedIn: false })).toBe(false);
  });
});
