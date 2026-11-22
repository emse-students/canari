// @vitest-environment happy-dom
/**
 * ONE NOTIFICATION PER MESSAGE ON AN IPHONE (`announcedMessages.ts`, Rust `mobile::announced`).
 *
 * Read on the iPhone 12, `1.7.3-alpha.6`: the extension drew a push with the app killed, and the
 * cold launch's catch-up raised the same message again from the page - two identical rows; a warm
 * resume left three. And a deleted group kept the page's banners, which carried no thread, while
 * the removal by thread took the extension's. So on iOS the page asks the shared ledger before it
 * raises, and every banner it raises is filed under the extension's thread for its conversation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sent: Record<string, unknown>[] = [];
const invoked: { cmd: string; args: Record<string, unknown> }[] = [];
let answer: (() => unknown) | null = null;

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => 'granted'),
  sendNotification: vi.fn((options: Record<string, unknown>) => {
    sent.push(options);
  }),
  removeActive: vi.fn(async () => {}),
  onAction: vi.fn(async () => ({ unregister: () => {} })),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    invoked.push({ cmd, args });
    if (!answer) throw new Error('no answer staged');
    return answer();
  }),
}));
vi.mock('$lib/utils/sessionLog', () => ({ appendLog: vi.fn() }));
vi.mock('$lib/utils/openExternal', () => ({ isTauriRuntime: () => true }));
vi.mock('$lib/utils/appVersion', async (orig) => ({
  ...(await orig<typeof import('$lib/utils/appVersion')>()),
  isAndroidTauriRuntime: () => false,
  isIosTauriRuntime: () => true,
}));

import { useNotifications } from './useNotifications.svelte';
import type { NativeMessageNotification } from '$lib/utils/nativeNotification';

const GROUP = 'daf33f9a-756c-4e00-9c1a-000000000001';

function message(instants: number[]): NativeMessageNotification {
  return {
    conversationId: GROUP,
    senderId: 'delta',
    senderName: 'Delta',
    groupName: 'A6R2DEL',
    body: 'a6 row2 del1',
    mentionsMe: false,
    sentAt: instants[instants.length - 1],
    serverAt: 0,
    covers: instants.length,
    instants,
    authorProven: false,
    isGroup: true,
  };
}

async function raise(instants: number[]) {
  const notifs = useNotifications();
  await notifs.sendSystemNotification('Delta', 'a6 row2 del1', GROUP, false, message(instants));
}

beforeEach(() => {
  sent.length = 0;
  invoked.length = 0;
  answer = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('an iPhone announces a message once, whichever process draws it', () => {
  it('stands down for a message the extension already showed, and says so once', async () => {
    answer = () => ({ raise: false, fresh: 0, byExtension: 1, byPage: 0, keys: [`${GROUP}:5`] });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await raise([5]);
    expect(invoked).toEqual([
      { cmd: 'claim_message_announcement', args: { conversationId: GROUP, instants: [5] } },
    ]);
    expect(sent).toEqual([]);
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('[NOTIF]'));
    expect(lines).toEqual([
      `[NOTIF] Not raised for ${GROUP} - every message of it was announced already (by the extension: 1, by this app: 0).`,
    ]);
  });

  it('claims every message of a catch-up flush for its one banner', async () => {
    answer = () => ({
      raise: true,
      fresh: 1,
      byExtension: 1,
      byPage: 0,
      keys: [`${GROUP}:5`, `${GROUP}:6`],
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await raise([5, 6]);
    expect(invoked[0].args).toEqual({ conversationId: GROUP, instants: [5, 6] });
    expect(sent).toHaveLength(1);
  });

  it("files the page's banner under the extension's thread and conversation field", async () => {
    answer = () => ({ raise: true, fresh: 1, byExtension: 0, byPage: 0, keys: [`${GROUP}:5`] });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await raise([5]);
    expect(sent).toHaveLength(1);
    expect(sent[0].group).toBe(GROUP);
    expect(sent[0].extra).toEqual({ groupId: GROUP, announces: `${GROUP}:5` });
  });

  it('raises, and accuses, when the ledger cannot answer - a message is never left unannounced', async () => {
    answer = () => {
      throw new Error('announced_messages.json unreadable');
    };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await raise([5]);
    expect(sent).toHaveLength(1);
    expect(sent[0].group).toBe(GROUP);
    expect(sent[0].extra).toEqual({ groupId: GROUP });
    expect(error).toHaveBeenCalledOnce();
    expect(String(error.mock.calls[0][0])).toContain('may repeat what the extension showed');
  });

  it('files a reaction under its conversation too, and asks no ledger for it', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const notifs = useNotifications();
    await notifs.sendReactionNotification({
      conversationId: GROUP,
      messageId: 'm1',
      actorId: 'delta',
      actorName: 'Delta',
      emoji: '❤️',
      at: 1_700_000_000_100,
    });
    expect(invoked).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0].group).toBe(GROUP);
  });
});
