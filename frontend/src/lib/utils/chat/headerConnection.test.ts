import { describe, expect, it } from 'vitest';
import { isHeaderConnected } from './headerConnection';

const base = { isWsConnected: false, isLoggedIn: true, isTabLeader: false, leaderConnected: true };

describe('isHeaderConnected', () => {
  it('is connected when the socket is open', () => {
    expect(isHeaderConnected({ ...base, isWsConnected: true, isTabLeader: true })).toBe(true);
  });
  it('a follower whose leader holds a socket is connected although it holds none', () => {
    expect(isHeaderConnected(base)).toBe(true);
  });
  it('a follower whose leader reports no socket, or none answering, is offline', () => {
    expect(isHeaderConnected({ ...base, leaderConnected: false })).toBe(false);
  });
  it('a leader without its socket is offline', () => {
    expect(isHeaderConnected({ ...base, isTabLeader: true })).toBe(false);
  });
  it('a signed-out page is offline', () => {
    expect(isHeaderConnected({ ...base, isLoggedIn: false })).toBe(false);
  });
});
