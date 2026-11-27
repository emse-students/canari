// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('$lib/mobile/androidMailWatch', () => ({
  NATIVE_MAIL_EVENT: 'canari:mail-native',
  startAndroidMailService: vi.fn(() => true),
  stopAndroidMailService: vi.fn(),
}));
vi.mock('$lib/stores/appVersionCheck.svelte', () => ({ serverMailMode: () => 'on' }));
vi.mock('$lib/utils/appForeground', () => ({ onAppScreenChange: () => () => {} }));
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
import {
  backgroundRefresh,
  backgroundRefreshWanted,
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
  wanted: true,
  state: 'ready' as MailSessionState['kind'],
  eligible: true,
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

  it('cleared by the switch off, the server off, a mail sign-out or a closed account', () => {
    expect(backgroundRefreshWanted(facts({ wanted: false }), 'ready')).toBe(false);
    expect(backgroundRefreshWanted(facts({ mailOn: false }), 'ready')).toBe(false);
    expect(backgroundRefreshWanted(facts({ client: null }), 'ready')).toBe(false);
    expect(backgroundRefreshWanted(facts({ state: 'signed_out' }), 'ready')).toBe(false);
    expect(backgroundRefreshWanted(facts({ state: 'closed' }), 'ready')).toBe(false);
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
