// @vitest-environment happy-dom
/**
 * A reaction notification the page raised goes with its conversation when the reader opens it
 * (web: closed; iOS and desktop: removed by id) - and only that conversation's.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const removeActive = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn(async () => false),
  requestPermission: vi.fn(async () => 'denied'),
  sendNotification: vi.fn(),
  removeActive,
  onAction: vi.fn(async () => ({ unregister: () => {} })),
  createChannel: vi.fn(async () => {}),
  channels: vi.fn(async () => []),
  Importance: { High: 4, Default: 3, Low: 2 },
  Visibility: { Public: 1, Private: 0 },
}));
vi.mock('$lib/utils/sessionLog', () => ({ appendLog: vi.fn() }));

import { useNotifications } from './useNotifications.svelte';

const closed: string[] = [];

class FakeNotification {
  static permission = 'granted';
  onclick: (() => void) | null = null;
  onclose: (() => void) | null = null;
  tag: string;
  constructor(_title: string, options: { tag?: string }) {
    this.tag = String(options.tag);
  }
  close() {
    closed.push(this.tag);
  }
}

beforeEach(() => {
  closed.length = 0;
  vi.stubGlobal('Notification', FakeNotification);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function reaction(conversationId: string, messageId: string) {
  return {
    conversationId,
    messageId,
    actorId: 'peer',
    actorName: 'Peer',
    emoji: '❤️',
    at: 1_700_000_000_100,
  };
}

describe('what the page holds of a reaction notification', () => {
  it('drops an entry when its notification closes by itself, so a never-opened conversation holds nothing', async () => {
    vi.useFakeTimers();
    try {
      const notifs = useNotifications();
      await notifs.sendReactionNotification(reaction('grp-1', 'm1'));
      await vi.advanceTimersByTimeAsync(8100);
      expect(await notifs.dismissConversationReactions('grp-1')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds ONE entry for a slot raised twice', async () => {
    const notifs = useNotifications();
    await notifs.sendReactionNotification(reaction('grp-1', 'm1'));
    await notifs.sendReactionNotification({
      ...reaction('grp-1', 'm1'),
      emoji: '😂',
      at: 1_700_000_000_400,
    });
    expect(await notifs.dismissConversationReactions('grp-1')).toBe(1);
  });
});

describe('dismissConversationReactions', () => {
  it("closes the opened conversation's reaction notifications and leaves the others", async () => {
    const notifs = useNotifications();
    await notifs.sendReactionNotification(reaction('grp-1', 'm1'));
    await notifs.sendReactionNotification(reaction('grp-2', 'm2'));

    expect(await notifs.dismissConversationReactions('grp-1')).toBe(1);
    expect(closed).toEqual(['canari-reaction:m1:peer']);
    // Idempotent: nothing left to take down.
    expect(await notifs.dismissConversationReactions('grp-1')).toBe(0);
  });

  it('has nothing to do for a conversation that raised none', async () => {
    const notifs = useNotifications();
    expect(await notifs.dismissConversationReactions('grp-9')).toBe(0);
    expect(removeActive).not.toHaveBeenCalled();
  });
});
