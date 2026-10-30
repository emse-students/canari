// @vitest-environment happy-dom
/**
 * THE GLOBAL BANNER CARRIES A PERSON'S ASK ONLY (owner, 2026-10-30). A device ask (`kind: 'device'`)
 * is drawn by `JoinRequestRow` inside its conversation, never here - and one queued ahead of a
 * person's ask must not hide it.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const state = vi.hoisted(() => ({ asks: [] as unknown[] }));
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalSession: { isLoggedIn: true, userId: 'me' },
  globalConvs: { conversations: new Map(), selectedContact: null },
}));
vi.mock('$lib/utils/chat/joinRequests.svelte', () => ({
  canAnswerJoinRequests: () => true,
  pendingJoinRequests: () => state.asks,
}));
vi.mock('$lib/utils/chat/joinRequestAnswer', () => ({ answerJoinRequestOrToast: vi.fn() }));
vi.mock('$lib/utils/users/displayName', () => ({ getUserDisplayNameSync: (id: string) => id }));

import JoinRequestBanner from './JoinRequestBanner.svelte';
import { m } from '$lib/paraglide/messages';

const mounted: (() => void)[] = [];
beforeEach(() => {
  state.asks = [];
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function mountBanner() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(JoinRequestBanner, { target });
  mounted.push(() => void unmount(app));
  flushSync();
  return target;
}

const device = { groupId: 'g1', userId: 'bob', deviceIds: ['d1'], kind: 'device' };
const person = { groupId: 'g2', userId: 'alice', deviceIds: ['d2'] };

describe('JoinRequestBanner', () => {
  it('shows nothing for a device ask alone', () => {
    state.asks = [device];
    expect(mountBanner().textContent).toBe('');
  });

  it("still shows a person's ask when an older device ask is ahead of it", () => {
    state.asks = [device, person];
    const text = mountBanner().textContent ?? '';
    expect(text).toContain(m.join_request_title());
    expect(text).toContain('alice');
    expect(text).not.toContain('bob');
  });
});
