// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ leader: false, user: 'u1' }));
vi.mock('$lib/mls-client/tabLeader', () => ({ getIsTabLeader: () => state.leader }));
vi.mock('$lib/stores/userState.svelte', () => ({ currentUserId: () => state.user }));

import {
  handleLeaderLinkEvent,
  leaderSocketConnected,
  resetLeaderLinkForTests,
} from './tabLeaderLink.svelte';

describe('the follower reads the leader socket', () => {
  beforeEach(() => {
    resetLeaderLinkForTests();
    state.leader = false;
  });

  it('reads offline until a leader answers', () => {
    expect(leaderSocketConnected()).toBe(false);
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
    state.leader = true;
    handleLeaderLinkEvent({ type: 'leader_link', connected: true, account: 'u1' });
    expect(leaderSocketConnected()).toBe(false);
  });
});
