// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';

const state = vi.hoisted(() => ({
  leadership: 'follower' as 'undecided' | 'leader' | 'follower',
  decide: null as ((v: 'leader' | 'follower') => void) | null,
}));
vi.mock('$lib/mls-client/tabLeader', () => ({
  getIsTabLeader: () => state.leadership === 'leader',
  getTabLeadership: () => state.leadership,
  whenTabLeadershipDecided: () =>
    new Promise<'leader' | 'follower'>((r) => {
      state.decide = (v) => {
        state.leadership = v;
        r(v);
      };
    }),
}));

import { setCurrentUserId } from '$lib/stores/userState.svelte';
import {
  handleLeaderLinkEvent,
  leaderReportsNoSocket,
  leaderSocketConnected,
  leadershipChanged,
  publishLeaderLink,
  resetLeaderLinkForTests,
  startLeaderLink,
  type TabLeaderLinkEvent,
} from './tabLeaderLink.svelte';

describe('the follower reads the leader socket', () => {
  beforeEach(() => {
    resetLeaderLinkForTests();
    state.leadership = 'follower';
    setCurrentUserId('u1');
  });

  it('reads offline until a leader answers', () => {
    expect(leaderSocketConnected()).toBe(false);
  });

  it('an unanswered leader is UNKNOWN, not "no socket": only an explicit false is', () => {
    expect(leaderReportsNoSocket()).toBe(false);
    handleLeaderLinkEvent({ type: 'leader_link', connected: false, account: 'u1' });
    expect(leaderReportsNoSocket()).toBe(true);
    handleLeaderLinkEvent({ type: 'leader_link', connected: true, account: 'u1' });
    expect(leaderReportsNoSocket()).toBe(false);
  });

  it('follows the published state of the leader', () => {
    handleLeaderLinkEvent({ type: 'leader_link', connected: true, account: 'u1' });
    expect(leaderSocketConnected()).toBe(true);
    handleLeaderLinkEvent({ type: 'leader_link', connected: false, account: 'u1' });
    expect(leaderSocketConnected()).toBe(false);
  });

  it('ignores another account in the same browser', () => {
    handleLeaderLinkEvent({ type: 'leader_link', connected: true, account: 'u2' });
    expect(leaderSocketConnected()).toBe(false);
  });

  it('a leader does not record a link as a follower would', () => {
    state.leadership = 'leader';
    handleLeaderLinkEvent({ type: 'leader_link', connected: true, account: 'u1' });
    expect(leaderSocketConnected()).toBe(false);
  });
});

/**
 * THE BOOT ORDER THAT LEFT A SECOND TAB "HORS-LIGNE": the link starts before the account is known.
 * A listener tab (a second BroadcastChannel on the same name) records every event that crosses.
 */
describe('the link announces itself when the account becomes known, never before', () => {
  let heard: TabLeaderLinkEvent[] = [];
  let spy: BroadcastChannel;
  let stop: (() => void) | null = null;

  beforeEach(() => {
    resetLeaderLinkForTests();
    heard = [];
    state.leadership = 'undecided';
    setCurrentUserId(null);
    spy = new BroadcastChannel('canari-tab-messages');
    spy.onmessage = (e) => heard.push(e.data as TabLeaderLinkEvent);
  });
  afterEach(() => {
    stop?.();
    stop = null;
    spy.close();
  });

  const crossed = async () => {
    // BroadcastChannel delivers on a later task: a few zero-delay turns let it land.
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    return heard;
  };

  it('a follower sends no query with an empty account, then asks once the account is known', async () => {
    stop = startLeaderLink();
    flushSync();
    state.decide?.('follower');
    await Promise.resolve();
    expect(await crossed()).toEqual([]);
    setCurrentUserId('u1');
    flushSync();
    expect(await crossed()).toEqual([{ type: 'leader_link_query', account: 'u1' }]);
  });

  it('a follower whose election settles after the account asks when it settles', async () => {
    setCurrentUserId('u1');
    stop = startLeaderLink();
    flushSync();
    expect(await crossed()).toEqual([]); // undecided: not a question yet
    state.decide?.('follower');
    await Promise.resolve();
    expect(await crossed()).toEqual([{ type: 'leader_link_query', account: 'u1' }]);
  });

  it('starts once per document: a second start adds no listener and no second query', async () => {
    setCurrentUserId('u1');
    const first = startLeaderLink();
    const second = startLeaderLink();
    stop = first;
    expect(second).toBe(first);
    flushSync();
    state.decide?.('follower');
    await Promise.resolve();
    expect(await crossed()).toEqual([{ type: 'leader_link_query', account: 'u1' }]);
  });

  it('forgets the last leader answer when the account changes or the role changes', async () => {
    setCurrentUserId('u1');
    state.leadership = 'follower';
    stop = startLeaderLink();
    flushSync();
    handleLeaderLinkEvent({ type: 'leader_link', connected: true, account: 'u1' });
    expect(leaderSocketConnected()).toBe(true);
    setCurrentUserId('u2');
    flushSync();
    expect(leaderSocketConnected()).toBe(false);
    handleLeaderLinkEvent({ type: 'leader_link', connected: true, account: 'u2' });
    expect(leaderSocketConnected()).toBe(true);
    leadershipChanged();
    expect(leaderSocketConnected()).toBe(false);
  });

  it('a leader republishes its socket when the account becomes known', async () => {
    stop = startLeaderLink();
    state.decide?.('leader');
    await Promise.resolve();
    publishLeaderLink(true); // socket opened before the account: stamped with no account
    await crossed();
    heard.length = 0;
    setCurrentUserId('u1');
    flushSync();
    expect(await crossed()).toEqual([{ type: 'leader_link', connected: true, account: 'u1' }]);
  });
});
