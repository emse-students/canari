// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('$lib/mobile/androidMailWatch', () => ({
  NATIVE_MAIL_EVENT: 'canari:mail-native',
  startAndroidMailService: vi.fn(() => true),
  stopAndroidMailService: vi.fn(),
  armAndroidMailWatch: vi.fn(() => true),
}));
vi.mock('$lib/stores/appVersionCheck.svelte', () => ({
  serverMailMode: () => 'on',
  serverMailModeKnown: () => true,
}));
const screen = vi.hoisted(() => ({ on: true }));
vi.mock('$lib/utils/appForeground', () => ({
  onAppScreenChange: () => () => {},
  isAppOnScreen: () => screen.on,
}));
vi.mock('$lib/utils/appVersion', () => ({
  isAndroidTauriRuntime: () => false,
  isIosTauriRuntime: () => false,
}));
vi.mock('./connect', () => ({ mailStreamOpener: vi.fn(), platformTransport: vi.fn() }));
vi.mock('./mailClient.svelte', () => ({ currentMailClient: () => null }));
vi.mock('./mailNotify', () => ({ postMailNotices: vi.fn() }));
vi.mock('./soapClient', () => ({ ZimbraSoapClient: vi.fn() }));
vi.mock('$lib/utils/apiUrl', () => ({ gatewayUrl: () => 'https://example.invalid' }));

import type { MailClient } from './mailClient.svelte';
import type { MailSessionState } from './mailSession';
import { armAndroidMailWatch } from '$lib/mobile/androidMailWatch';
import {
  armNativeCopyIfCurrent,
  backgroundRefresh,
  backgroundRefreshWanted,
  eraseCursorOnceStopped,
  mailTabOnScreen,
  nativeWatchWanted,
  pauseUntilRetry,
  watcherShouldRun,
} from './mailWatch.svelte';
import {
  forgetMailNotificationsSwitch,
  mailNotificationsWanted,
  setMailNotificationsWanted,
} from './mailWatchSwitch.svelte';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';

/**
 * WHEN THE NEW-MAIL WATCHER RUNS (lot 4): four facts, every one read - the server's switch, the
 * address, the open mailbox and the account's switch, OFF by default. Any of them false stops it.
 */

const client = { userId: 'u1' } as unknown as MailClient;
const facts = (over: Partial<Parameters<typeof watcherShouldRun>[0]> = {}) => ({
  client,
  mailOn: true,
  mailKnown: true,
  wanted: true,
  state: 'ready' as MailSessionState['kind'],
  eligible: true,
  remembered: true,
  ...over,
});

class MemoryStorage {
  private items = new Map<string, string>();
  getItem(k: string) {
    return this.items.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.items.set(k, v);
  }
  removeItem(k: string) {
    this.items.delete(k);
  }
}

describe('watcherShouldRun', () => {
  it('runs only when all four facts agree', () => {
    expect(watcherShouldRun(facts())).toBe(true);
    expect(watcherShouldRun(facts({ client: null }))).toBe(false);
    expect(watcherShouldRun(facts({ mailOn: false }))).toBe(false);
    expect(watcherShouldRun(facts({ wanted: false }))).toBe(false);
    expect(watcherShouldRun(facts({ eligible: false }))).toBe(false);
    for (const state of ['signed_out', 'closed', 'needs_password', 'unavailable'] as const)
      expect(watcherShouldRun(facts({ state }))).toBe(false);
  });
});

describe('backgroundRefreshWanted (the iOS flag)', () => {
  it('asked for while wanted, even before the mailbox reopens at launch', () => {
    expect(backgroundRefreshWanted(facts(), null)).toBe(true);
    expect(backgroundRefreshWanted(facts({ state: 'signed_out' }), null)).toBeNull();
  });

  it('cleared only by a fact READ: the switch off, the server off, a mail sign-out, a closed account', () => {
    expect(backgroundRefreshWanted(facts({ wanted: false }), 'ready')).toBe(false);
    expect(backgroundRefreshWanted(facts({ mailOn: false }), 'ready')).toBe(false);
    expect(backgroundRefreshWanted(facts({ state: 'signed_out' }), 'ready')).toBe(false);
    expect(backgroundRefreshWanted(facts({ state: 'closed' }), 'ready')).toBe(false);
  });

  it('left alone (null) while a fact is still UNKNOWN: no server answer yet, no client yet', () => {
    expect(backgroundRefreshWanted(facts({ mailKnown: false, mailOn: false }), 'ready')).toBeNull();
    expect(backgroundRefreshWanted(facts({ mailKnown: false }), null)).toBeNull();
    expect(backgroundRefreshWanted(facts({ client: null }), 'ready')).toBeNull();
  });
});

describe('nativeWatchWanted (the Android sealed copy, lot 4b)', () => {
  it('armed only while wanted AND remembered, from read facts', () => {
    expect(nativeWatchWanted(facts(), null)).toBe(true);
    expect(nativeWatchWanted(facts({ remembered: false }), null)).toBe(false);
  });

  it('erased by any fact read false: the switch, the server, a mail sign-out, a closed account', () => {
    expect(nativeWatchWanted(facts({ wanted: false }), 'ready')).toBe(false);
    expect(nativeWatchWanted(facts({ mailOn: false }), 'ready')).toBe(false);
    expect(nativeWatchWanted(facts({ state: 'signed_out' }), 'ready')).toBe(false);
    expect(nativeWatchWanted(facts({ state: 'closed' }), 'ready')).toBe(false);
  });

  it('left alone while a fact is unknown: a launch has not read them yet', () => {
    expect(nativeWatchWanted(facts({ mailKnown: false }), null)).toBeNull();
    expect(nativeWatchWanted(facts({ client: null }), 'ready')).toBeNull();
    expect(nativeWatchWanted(facts({ state: 'signed_out', remembered: false }), null)).toBeNull();
  });
});

describe('mailTabOnScreen (no notice for a mail seen landing)', () => {
  it('true only on the Mail tab, with the app on screen', () => {
    screen.on = true;
    window.history.replaceState(null, '', '/mail/-12');
    expect(mailTabOnScreen()).toBe(true);
    window.history.replaceState(null, '', '/mail');
    expect(mailTabOnScreen()).toBe(true);
    window.history.replaceState(null, '', '/mailbox-elsewhere');
    expect(mailTabOnScreen()).toBe(false);
    window.history.replaceState(null, '', '/chat');
    expect(mailTabOnScreen()).toBe(false);
    window.history.replaceState(null, '', '/mail');
    screen.on = false;
    expect(mailTabOnScreen()).toBe(false);
    screen.on = true;
  });
});

describe('the switch turned off (I1)', () => {
  it('erases the cursor only once the run has stopped, so a run still reading cannot write it back', async () => {
    const order: string[] = [];
    let stop!: () => void;
    const stopped = new Promise<void>((r) => (stop = r));
    const store = {
      read: vi.fn(),
      write: vi.fn(),
      erase: vi.fn(async (u: string) => {
        order.push(`erase ${u}`);
      }),
    };
    const erased = eraseCursorOnceStopped(stopped, 'u1', store);
    await Promise.resolve();
    expect(store.erase).not.toHaveBeenCalled();
    order.push('stopped');
    stop();
    await erased;
    expect(order).toEqual(['stopped', 'erase u1']);
  });
});

describe('backgroundRefresh', () => {
  it('reads nothing when the watch is not wanted', async () => {
    const resume = vi.fn();
    const off = { ...facts({ wanted: false }), client: { userId: 'u1', session: { resume } } };
    expect(await backgroundRefresh(off as never)).toBe('off');
    expect(await backgroundRefresh(null)).toBe('off');
    expect(resume).not.toHaveBeenCalled();
  });

  it('a mailbox that does not reopen is "not_ready", never a throw', async () => {
    const session = {
      state: { kind: 'signed_out' },
      resume: vi.fn(async () => Promise.reject(new Error('x'))),
    };
    const f = { ...facts(), client: { userId: 'u1', session } };
    expect(await backgroundRefresh(f as never)).toBe('not_ready');
  });

  it('a mailbox that needs its password is "not_ready", and nothing is read', async () => {
    const session = { state: { kind: 'signed_out' }, resume: vi.fn(async () => false) };
    const f = { ...facts(), client: { userId: 'u1', session } };
    expect(await backgroundRefresh(f as never)).toBe('not_ready');
  });
});

describe('pauseUntilRetry', () => {
  it('ends early on the network coming back, and at once on abort', async () => {
    const controller = new AbortController();
    let ended = false;
    const p = pauseUntilRetry(3_600_000, controller.signal).then(() => (ended = true));
    window.dispatchEvent(new Event('online'));
    await p;
    expect(ended).toBe(true);
    controller.abort();
    await pauseUntilRetry(3_600_000, controller.signal);
  });
});

describe('the switch "Notifications de nouveaux mails"', () => {
  let store: MemoryStorage;
  beforeEach(() => {
    store = new MemoryStorage();
    forgetMailNotificationsSwitch('u1');
  });

  it('is off by default', () => {
    expect(mailNotificationsWanted('u1', store as unknown as Storage)).toBe(false);
  });

  it('is kept for the account on this device, and off removes the key', () => {
    setMailNotificationsWanted('u1', true, store as unknown as Storage);
    expect(store.getItem(ACCOUNT_KEY.mailNotifications('u1'))).toBe('1');
    forgetMailNotificationsSwitch('u1');
    expect(mailNotificationsWanted('u1', store as unknown as Storage)).toBe(true);
    setMailNotificationsWanted('u1', false, store as unknown as Storage);
    expect(store.getItem(ACCOUNT_KEY.mailNotifications('u1'))).toBeNull();
  });

  it('is off again once D8 erased its key and the cache was forgotten', () => {
    setMailNotificationsWanted('u1', true, store as unknown as Storage);
    store.removeItem(ACCOUNT_KEY.mailNotifications('u1'));
    forgetMailNotificationsSwitch('u1');
    expect(mailNotificationsWanted('u1', store as unknown as Storage)).toBe(false);
  });
});

describe('armNativeCopyIfCurrent (review I3: no stale arm)', () => {
  const remembered = { account: 'ada@etu.emse.fr', password: 'pw' };
  const sessionWith = (onRead: (session: { generation: number }) => void) => {
    const session = {
      generation: 1,
      rememberedForNativeWatch: async () => {
        onRead(session);
        return remembered;
      },
    };
    return { userId: 'u1', session } as unknown as MailClient;
  };

  beforeEach(() => vi.mocked(armAndroidMailWatch).mockClear());

  it('arms when nothing moved while the password was read', async () => {
    expect(
      await armNativeCopyIfCurrent(
        sessionWith(() => {}),
        () => true
      )
    ).toBe(true);
    expect(armAndroidMailWatch).toHaveBeenCalledWith('u1', 'ada@etu.emse.fr', 'pw');
  });

  it('sends nothing once the page decided otherwise (an erase came after)', async () => {
    expect(
      await armNativeCopyIfCurrent(
        sessionWith(() => {}),
        () => false
      )
    ).toBe(false);
    expect(armAndroidMailWatch).not.toHaveBeenCalled();
  });

  it('sends nothing once the session moved (a sign-out or a new sign-in during the read)', async () => {
    const client = sessionWith((session) => (session.generation = 2));
    expect(await armNativeCopyIfCurrent(client, () => true)).toBe(false);
    expect(armAndroidMailWatch).not.toHaveBeenCalled();
  });
});
