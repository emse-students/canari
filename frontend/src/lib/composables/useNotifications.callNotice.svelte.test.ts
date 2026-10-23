// @vitest-environment happy-dom
/**
 * AN INCOMING CALL IS NOT ANNOUNCED TWICE ON SCREEN (CALL-OS-BANNER, iPhone, 2026-10-19).
 *
 * With the app in the foreground the ring is already the whole screen (`CallOverlay`), and an OS
 * banner "Appel entrant" was drawn on top of it. The notice is deferred while the page is visible,
 * posted if the page hides while the call still rings, and dropped once the ring is over.
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
const logs = vi.hoisted(() => [] as string[]);
vi.mock('$lib/utils/sessionLog', () => ({ appendLog: (l: string) => logs.push(l) }));

import { useNotifications } from './useNotifications.svelte';

let visibility: DocumentVisibilityState = 'visible';
const posted: string[] = [];

class FakeNotification {
  static permission = 'granted';
  onclick: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(title: string) {
    posted.push(title);
  }
  close() {}
}

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  logs.length = 0;
  posted.length = 0;
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  vi.stubGlobal('Notification', FakeNotification);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the incoming-call OS notification', () => {
  it('is not posted while the app is on screen, and is posted when it leaves while ringing', async () => {
    const notifs = useNotifications();
    await notifs.notifyIncomingCall('Bob', 'g1');
    expect(posted).toEqual([]);
    expect(logs.join('\n')).toContain('rings in-app - no OS notification');

    setVisibility('hidden');
    await vi.waitFor(() => expect(posted).toHaveLength(1));

    // Once posted, a later hide/show cycle does not post it again.
    setVisibility('visible');
    setVisibility('hidden');
    await Promise.resolve();
    expect(posted).toHaveLength(1);
  });

  it('is dropped when the ring ends before the app leaves the screen', async () => {
    const notifs = useNotifications();
    await notifs.notifyIncomingCall('Bob', 'g1');
    await notifs.dismissIncomingCall();
    setVisibility('hidden');
    await Promise.resolve();
    expect(posted).toEqual([]);
  });

  it('is posted at once when the app is already off screen', async () => {
    visibility = 'hidden';
    const notifs = useNotifications();
    await notifs.notifyIncomingCall('Bob', 'g1');
    expect(posted).toHaveLength(1);
  });
});
