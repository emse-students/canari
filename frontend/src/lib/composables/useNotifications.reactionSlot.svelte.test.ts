// @vitest-environment happy-dom
/**
 * ONE NOTIFICATION SLOT PER REACTOR AND MESSAGE, ONE THROTTLE WINDOW PER REACTION (2026-11-18).
 *
 * The id/tag of a reaction's notification is `reactionCollapseKey` - no instant - so a reactor's
 * second reaction to one message REPLACES the first, as on Android. The 800 ms throttle stays keyed by
 * the reaction itself (`<slot>:<at>`): keyed by the slot, a quick second emoji would be swallowed and
 * the entry would keep reading the first.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn(async () => false),
  requestPermission: vi.fn(async () => 'denied'),
  sendNotification: vi.fn(),
  removeActive: vi.fn(async () => {}),
  onAction: vi.fn(async () => ({ unregister: () => {} })),
  createChannel: vi.fn(async () => {}),
  channels: vi.fn(async () => []),
  Importance: { High: 4, Default: 3, Low: 2 },
  Visibility: { Public: 1, Private: 0 },
}));
vi.mock('$lib/utils/sessionLog', () => ({ appendLog: vi.fn() }));

import { useNotifications } from './useNotifications.svelte';

const tags: string[] = [];

class FakeNotification {
  static permission = 'granted';
  onclick: (() => void) | null = null;
  constructor(_title: string, options: { tag?: string }) {
    tags.push(String(options.tag));
  }
  close() {}
}

beforeEach(() => {
  tags.length = 0;
  vi.stubGlobal('Notification', FakeNotification);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function reaction(at: number, emoji: string, actorId = 'peer', messageId = 'msg-1') {
  return { conversationId: 'grp-1', messageId, actorId, actorName: 'Peer', emoji, at };
}

describe('a reaction notification on web and desktop', () => {
  it("a reactor's quick second reaction is raised, into the SAME slot as the first", async () => {
    const notifs = useNotifications();
    await notifs.sendReactionNotification(reaction(1_700_000_000_100, '❤️'));
    await notifs.sendReactionNotification(reaction(1_700_000_000_400, '😂'));
    expect(tags).toEqual(['canari-reaction:msg-1:peer', 'canari-reaction:msg-1:peer']);
  });

  it('the SAME reaction twice inside the window is raised once', async () => {
    const notifs = useNotifications();
    await notifs.sendReactionNotification(reaction(1_700_000_000_100, '❤️', 'other'));
    await notifs.sendReactionNotification(reaction(1_700_000_000_100, '❤️', 'other'));
    expect(tags).toHaveLength(1);
  });

  it('another reactor keeps a slot of its own', async () => {
    const notifs = useNotifications();
    await notifs.sendReactionNotification(reaction(1_700_000_000_100, '❤️', 'third', 'msg-9'));
    await notifs.sendReactionNotification(reaction(1_700_000_000_100, '❤️', 'fourth', 'msg-9'));
    expect(new Set(tags).size).toBe(2);
  });
});
