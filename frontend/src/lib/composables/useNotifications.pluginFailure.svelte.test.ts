// @vitest-environment happy-dom
/**
 * A plugin that THROWS in a Tauri runtime is accused and raises nothing - it does not fall through
 * to the WebView's `Notification`, which would draw a second, differently-identified notification.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => 'granted'),
  sendNotification: vi.fn(() => {
    throw new TypeError('plugin unavailable');
  }),
  removeActive: vi.fn(async () => {}),
  onAction: vi.fn(async () => ({ unregister: () => {} })),
  createChannel: vi.fn(async () => {}),
  channels: vi.fn(async () => []),
  Importance: { High: 4, Default: 3, Low: 2 },
  Visibility: { Public: 1, Private: 0 },
}));
vi.mock('$lib/utils/sessionLog', () => ({ appendLog: vi.fn() }));
vi.mock('$lib/utils/openExternal', () => ({ isTauriRuntime: () => true }));
vi.mock('$lib/utils/appVersion', async (orig) => ({
  ...(await orig<typeof import('$lib/utils/appVersion')>()),
  isAndroidTauriRuntime: () => false,
}));

import { useNotifications } from './useNotifications.svelte';

const constructed: string[] = [];

class FakeNotification {
  static permission = 'granted';
  constructor(title: string) {
    constructed.push(title);
  }
  close() {}
}

beforeEach(() => {
  constructed.length = 0;
  vi.stubGlobal('Notification', FakeNotification);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('a throwing notification plugin', () => {
  it('is accused with its error type and does not reach the browser API', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const notifs = useNotifications();
    await notifs.sendReactionNotification({
      conversationId: 'grp-1',
      messageId: 'm1',
      actorId: 'peer',
      actorName: 'Peer',
      emoji: '❤️',
      at: 1_700_000_000_100,
    });
    expect(constructed).toEqual([]);
    expect(error).toHaveBeenCalledOnce();
    expect(String(error.mock.calls[0][0])).toContain('TypeError');
  });
});
