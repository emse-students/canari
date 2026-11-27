// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';

const api = vi.hoisted(() => ({
  fetchNotificationPreferences: vi.fn(),
  fetchChannelNotificationLevel: vi.fn(),
  saveDisabledCategories: vi.fn(),
  saveGroupNotificationLevel: vi.fn(),
  saveGroupCallsAllowed: vi.fn(),
}));
vi.mock('$lib/notifications/preferencesApi', () => api);

import { notificationPreferences } from './notificationPreferences.svelte';
import { eraseNotificationPreferenceCopies } from '$lib/notifications/preferencesSnapshot';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import { APP_FOREGROUND_EVENT } from '$lib/utils/appForeground';

/** The account every test starts signed in as: the store reads and decides only for a bound account. */
const A = 'account-a';

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  notificationPreferences.reset();
  notificationPreferences.bind(A, { offline: false });
  api.saveDisabledCategories.mockResolvedValue(undefined);
  api.saveGroupNotificationLevel.mockResolvedValue(undefined);
  api.saveGroupCallsAllowed.mockResolvedValue(undefined);
});

describe('notificationPreferences', () => {
  it('has everything on, and no push of Suggestions, until the server says otherwise ("Deux niveaux")', () => {
    expect(notificationPreferences.isEnabled('messages')).toBe(true);
    expect(notificationPreferences.isEnabled('suggestions')).toBe(true);
    expect(notificationPreferences.isPushEnabled('suggestions')).toBe(false);
    expect(notificationPreferences.pushAllowed('suggestions')).toBe(false);
    expect(notificationPreferences.pushAllowed('messages')).toBe(true);
    expect(notificationPreferences.disabled).toEqual([]);
  });

  it('a save before the first load never turns a push on by omission, and declares the opt-in reading', async () => {
    await notificationPreferences.setEnabled('posts', false);
    expect(api.saveDisabledCategories).toHaveBeenLastCalledWith(['posts'], [], []);
  });

  it('mirrors the server sets after a load', async () => {
    api.fetchNotificationPreferences.mockResolvedValue({
      disabled: ['posts', 'forms'],
      unknownDisabled: [],
      pushEnabled: ['suggestions'],
      groupLevels: {},
      groupCalls: {},
    });
    expect(await notificationPreferences.load()).toBe(true);
    expect(notificationPreferences.isEnabled('posts')).toBe(false);
    expect(notificationPreferences.isEnabled('messages')).toBe(true);
    expect(notificationPreferences.isPushEnabled('suggestions')).toBe(true);
    expect(notificationPreferences.pushAllowed('suggestions')).toBe(true);
  });

  it('keeps the current set and reports false when the load fails', async () => {
    api.fetchNotificationPreferences.mockResolvedValueOnce({
      disabled: ['posts'],
      unknownDisabled: [],
      pushEnabled: [],
      groupLevels: {},
      groupCalls: {},
    });
    await notificationPreferences.load();
    api.fetchNotificationPreferences.mockRejectedValueOnce(new Error('503'));
    expect(await notificationPreferences.load()).toBe(false);
    expect(notificationPreferences.isEnabled('posts')).toBe(false);
  });

  it('moves the switch at once and sends the whole disabled set', async () => {
    const pending = notificationPreferences.setEnabled('events', false);
    expect(notificationPreferences.isEnabled('events')).toBe(false);
    expect(await pending).toBe(true);
    expect(api.saveDisabledCategories).toHaveBeenCalledWith(['events'], [], []);

    await notificationPreferences.setEnabled('forms', false);
    expect(api.saveDisabledCategories).toHaveBeenLastCalledWith(['events', 'forms'], [], []);

    await notificationPreferences.setEnabled('events', true);
    expect(api.saveDisabledCategories).toHaveBeenLastCalledWith(['forms'], [], []);
  });

  it('the push of Suggestions: turning it on turns the app switch on; the app switch off takes the push with it', async () => {
    await notificationPreferences.setEnabled('suggestions', false);
    await notificationPreferences.setPushEnabled('suggestions', true);
    expect(notificationPreferences.isEnabled('suggestions')).toBe(true);
    expect(api.saveDisabledCategories).toHaveBeenLastCalledWith([], [], ['suggestions']);
    // One gesture: the app switch off silences the push too.
    await notificationPreferences.setEnabled('suggestions', false);
    expect(notificationPreferences.isPushEnabled('suggestions')).toBe(false);
    expect(api.saveDisabledCategories).toHaveBeenLastCalledWith(['suggestions'], [], []);
    // Push off alone leaves the app switch where it is.
    await notificationPreferences.setPushEnabled('suggestions', true);
    await notificationPreferences.setPushEnabled('suggestions', false);
    expect(notificationPreferences.isEnabled('suggestions')).toBe(true);
    expect(api.saveDisabledCategories).toHaveBeenLastCalledWith([], [], []);
  });

  it('refuses the push switch of a category that is not opt-in', async () => {
    expect(await notificationPreferences.setPushEnabled('posts', true)).toBe(false);
    expect(api.saveDisabledCategories).not.toHaveBeenCalled();
  });

  it('puts both switches back when the server refuses a push write', async () => {
    await notificationPreferences.setEnabled('suggestions', false);
    api.saveDisabledCategories.mockRejectedValueOnce(new Error('500'));
    expect(await notificationPreferences.setPushEnabled('suggestions', true)).toBe(false);
    expect(notificationPreferences.isEnabled('suggestions')).toBe(false);
    expect(notificationPreferences.isPushEnabled('suggestions')).toBe(false);
  });

  it('sends back, on every save, the switched-off ids this build does not know', async () => {
    api.fetchNotificationPreferences.mockResolvedValue({
      disabled: ['posts'],
      unknownDisabled: ['a_category_from_later'],
      pushEnabled: [],
      groupLevels: {},
      groupCalls: {},
    });
    await notificationPreferences.load();
    expect(notificationPreferences.disabled).toEqual(['posts']);
    await notificationPreferences.setEnabled('posts', true);
    expect(api.saveDisabledCategories).toHaveBeenLastCalledWith([], ['a_category_from_later'], []);
    // A sign-out forgets them with the rest: the next account never sends another's choice.
    notificationPreferences.reset();
    await notificationPreferences.setEnabled('forms', false);
    expect(api.saveDisabledCategories).toHaveBeenLastCalledWith(['forms'], [], []);
  });

  it('puts the switch back when the server refuses the write', async () => {
    api.saveDisabledCategories.mockRejectedValueOnce(new Error('500'));
    expect(await notificationPreferences.setEnabled('mentions', false)).toBe(false);
    expect(notificationPreferences.isEnabled('mentions')).toBe(true);
  });

  it('writes nothing when the switch is already where it was asked to go', async () => {
    expect(await notificationPreferences.setEnabled('messages', true)).toBe(true);
    expect(api.saveDisabledCategories).not.toHaveBeenCalled();
  });

  it('forgets the sets on reset, so the next account never inherits them', async () => {
    await notificationPreferences.setEnabled('posts', false);
    await notificationPreferences.setPushEnabled('suggestions', true);
    notificationPreferences.reset();
    expect(notificationPreferences.isEnabled('posts')).toBe(true);
    expect(notificationPreferences.isPushEnabled('suggestions')).toBe(false);
  });

  describe('private conversation levels', () => {
    const g = '0b9f3d7e-1111-4222-8333-444455556666';

    it('reads all for a conversation the server never named, and loaded only once answered', async () => {
      expect(notificationPreferences.groupLevel(g)).toBe('all');
      expect(notificationPreferences.loaded).toBe(false);
      api.fetchNotificationPreferences.mockResolvedValue({
        disabled: [],
        unknownDisabled: [],
        groupLevels: { [g]: 'mentions' },
        groupCalls: {},
      });
      await notificationPreferences.load();
      expect(notificationPreferences.loaded).toBe(true);
      expect(notificationPreferences.groupLevel(g)).toBe('mentions');
    });

    it('moves the level at once and writes it for that conversation', async () => {
      expect(await notificationPreferences.setGroupLevel(g, 'none')).toBe(true);
      expect(notificationPreferences.groupLevel(g)).toBe('none');
      expect(api.saveGroupNotificationLevel).toHaveBeenCalledWith(g, 'none');
    });

    it('puts the level back when the server refuses', async () => {
      await notificationPreferences.setGroupLevel(g, 'mentions');
      api.saveGroupNotificationLevel.mockRejectedValueOnce(new Error('403'));
      expect(await notificationPreferences.setGroupLevel(g, 'none')).toBe(false);
      expect(notificationPreferences.groupLevel(g)).toBe('mentions');
    });

    it('forgets the levels on reset', async () => {
      await notificationPreferences.setGroupLevel(g, 'none');
      notificationPreferences.reset();
      expect(notificationPreferences.groupLevel(g)).toBe('all');
    });
  });

  describe('a private conversation call permission', () => {
    const g = '0b9f3d7e-1111-4222-8333-444455556666';

    it('rings by default, and follows the level while the account never chose', async () => {
      expect(notificationPreferences.callsAllowed(g)).toBe(true);
      await notificationPreferences.setGroupLevel(g, 'mentions');
      expect(notificationPreferences.callsAllowed(g)).toBe(true);
      await notificationPreferences.setGroupLevel(g, 'none');
      expect(notificationPreferences.callsAllowed(g)).toBe(false);
    });

    it('an explicit choice from the server wins over the level', async () => {
      api.fetchNotificationPreferences.mockResolvedValue({
        disabled: [],
        unknownDisabled: [],
        groupLevels: { [g]: 'none' },
        groupCalls: { [g]: true },
      });
      await notificationPreferences.load();
      expect(notificationPreferences.callsAllowed(g)).toBe(true);
    });

    it('moves at once and writes the choice for that conversation', async () => {
      expect(await notificationPreferences.setGroupCallsAllowed(g, false)).toBe(true);
      expect(notificationPreferences.callsAllowed(g)).toBe(false);
      expect(api.saveGroupCallsAllowed).toHaveBeenCalledWith(g, false);
    });

    it('returns to "never chose" when the server refuses the first choice', async () => {
      await notificationPreferences.setGroupLevel(g, 'none');
      api.saveGroupCallsAllowed.mockRejectedValueOnce(new Error('403'));
      expect(await notificationPreferences.setGroupCallsAllowed(g, true)).toBe(false);
      expect(notificationPreferences.callsAllowed(g)).toBe(false);
      // Still following the level: back to `all`, it rings again.
      await notificationPreferences.setGroupLevel(g, 'all');
      expect(notificationPreferences.callsAllowed(g)).toBe(true);
    });

    it('forgets the choices on reset', async () => {
      await notificationPreferences.setGroupCallsAllowed(g, false);
      notificationPreferences.reset();
      expect(notificationPreferences.callsAllowed(g)).toBe(true);
    });
  });
});

describe('notificationPreferences.answered - a decision waits for the first answer', () => {
  const G = '0b9f3d7e-1111-4222-8333-444455556666';
  const answer = (groupLevels: Record<string, string>) => ({
    disabled: [],
    unknownDisabled: [],
    pushEnabled: [],
    groupLevels,
    groupCalls: {},
  });

  beforeEach(() => {
    localStorage.clear();
  });

  it('is answered at once once loaded, and shares one in-flight read otherwise', async () => {
    let resolve!: (v: unknown) => void;
    api.fetchNotificationPreferences.mockReturnValue(new Promise((r) => (resolve = r)));
    const a = notificationPreferences.answered();
    const b = notificationPreferences.load();
    resolve(answer({ [G]: 'none' }));
    expect(await a).toEqual({ kind: 'answered' });
    expect(await b).toBe(true);
    expect(api.fetchNotificationPreferences).toHaveBeenCalledTimes(1);
    expect(notificationPreferences.groupLevel(G)).toBe('none');
    expect(await notificationPreferences.answered()).toEqual({ kind: 'answered' });
    expect(api.fetchNotificationPreferences).toHaveBeenCalledTimes(1);
  });

  it('is unanswered on a failed read, and LATCHES: no new read until connectivity or an explicit load', async () => {
    api.fetchNotificationPreferences.mockRejectedValueOnce(new Error('offline'));
    expect(await notificationPreferences.answered()).toEqual({
      kind: 'unanswered',
      source: 'default',
    });
    expect(await notificationPreferences.answered()).toEqual({
      kind: 'unanswered',
      source: 'default',
    });
    expect(api.fetchNotificationPreferences).toHaveBeenCalledTimes(1);
    api.fetchNotificationPreferences.mockResolvedValueOnce(answer({}));
    expect(await notificationPreferences.load()).toBe(true);
    expect(api.fetchNotificationPreferences).toHaveBeenCalledTimes(2);
  });

  it('is superseded when the account signs out while it waits, and the stale answer is dropped', async () => {
    let resolve!: (v: unknown) => void;
    api.fetchNotificationPreferences.mockReturnValue(new Promise((r) => (resolve = r)));
    const waiting = notificationPreferences.answered();
    notificationPreferences.reset();
    resolve(answer({ [G]: 'none' }));
    expect(await waiting).toEqual({ kind: 'superseded' });
    expect(notificationPreferences.loaded).toBe(false);
    expect(notificationPreferences.groupLevel(G)).toBe('all');
  });

  it('reads nothing and decides nothing with no account bound', async () => {
    notificationPreferences.reset();
    expect(await notificationPreferences.answered()).toEqual({ kind: 'superseded' });
    expect(await notificationPreferences.load()).toBe(false);
    expect(api.fetchNotificationPreferences).not.toHaveBeenCalled();
  });

  it('is answered by the new session when the SAME account signs out and in while it waits', async () => {
    let resolveOld!: (v: unknown) => void;
    api.fetchNotificationPreferences.mockReturnValueOnce(new Promise((r) => (resolveOld = r)));
    const waiting = notificationPreferences.answered();
    notificationPreferences.reset();
    notificationPreferences.bind(A, { offline: false });
    api.fetchNotificationPreferences.mockResolvedValueOnce(answer({ [G]: 'none' }));
    resolveOld(answer({}));
    expect(await waiting).toEqual({ kind: 'answered' });
    expect(notificationPreferences.groupLevel(G)).toBe('none');
    expect(api.fetchNotificationPreferences).toHaveBeenCalledTimes(2);
  });

  it('is superseded when ANOTHER account signs in while it waits', async () => {
    let resolve!: (v: unknown) => void;
    api.fetchNotificationPreferences.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const waiting = notificationPreferences.answered();
    notificationPreferences.reset();
    notificationPreferences.bind('account-b', { offline: true });
    resolve(answer({ [G]: 'none' }));
    expect(await waiting).toEqual({ kind: 'superseded' });
    expect(notificationPreferences.groupLevel(G)).toBe('all');
  });

  it('lifts the latch when the app comes back on screen - a 5xx is no disconnection', async () => {
    api.fetchNotificationPreferences.mockRejectedValueOnce(new Error('HTTP 503'));
    expect(await notificationPreferences.answered()).toEqual({
      kind: 'unanswered',
      source: 'default',
    });
    api.fetchNotificationPreferences.mockResolvedValueOnce(answer({ [G]: 'none' }));
    window.dispatchEvent(new CustomEvent(APP_FOREGROUND_EVENT, { detail: { foreground: false } }));
    expect(api.fetchNotificationPreferences).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new CustomEvent(APP_FOREGROUND_EVENT, { detail: { foreground: true } }));
    expect(await notificationPreferences.answered()).toEqual({ kind: 'answered' });
    expect(notificationPreferences.groupLevel(G)).toBe('none');
    expect(api.fetchNotificationPreferences).toHaveBeenCalledTimes(2);
  });

  it('a save answering after its account signed out writes no copy, and reverts nothing, under the next', async () => {
    let settle!: () => void;
    api.saveGroupNotificationLevel.mockReturnValueOnce(new Promise<void>((r) => (settle = r)));
    const saving = notificationPreferences.setGroupLevel(G, 'none');
    notificationPreferences.reset();
    notificationPreferences.bind('account-b', { offline: true });
    settle();
    await saving;
    expect(localStorage.getItem(ACCOUNT_KEY.notificationPreferences('account-b'))).toBeNull();
    expect(localStorage.getItem(ACCOUNT_KEY.notificationPreferences(A))).toBeNull();

    let refuse!: (e: Error) => void;
    api.saveGroupCallsAllowed.mockReturnValueOnce(new Promise<void>((_, r) => (refuse = r)));
    const refused = notificationPreferences.setGroupCallsAllowed(G, false);
    notificationPreferences.reset();
    notificationPreferences.bind(A, { offline: true });
    await notificationPreferences.setGroupCallsAllowed(G, false);
    refuse(new Error('500'));
    expect(await refused).toBe(false);
    // The next session's own choice stands: the leaving session's refusal reverted nothing of it.
    expect(notificationPreferences.callsAllowed(G)).toBe(false);
  });

  it('drops a salon level that answers after its account signed out', async () => {
    let resolve!: (v: unknown) => void;
    api.fetchChannelNotificationLevel.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const reading = notificationPreferences.loadChannelLevel('channel_abc');
    notificationPreferences.reset();
    notificationPreferences.bind('account-b', { offline: true });
    resolve('none');
    expect(await reading).toBe(false);
    expect(notificationPreferences.channelLevel('channel_abc')).toBeUndefined();
  });

  it('erases every account copy by prefix, keeping only the one asked', () => {
    localStorage.setItem(ACCOUNT_KEY.notificationPreferences('x'), '{}');
    localStorage.setItem(ACCOUNT_KEY.notificationPreferences('y'), '{}');
    localStorage.setItem('unrelated', '1');
    expect(eraseNotificationPreferenceCopies('y')).toBe(1);
    expect(localStorage.getItem(ACCOUNT_KEY.notificationPreferences('y'))).toBe('{}');
    expect(eraseNotificationPreferenceCopies()).toBe(1);
    expect(localStorage.getItem(ACCOUNT_KEY.notificationPreferences('y'))).toBeNull();
    expect(localStorage.getItem('unrelated')).toBe('1');
  });

  it('applies the account copy of the last answer at sign-in, and never another account copy', async () => {
    notificationPreferences.bind('account-a', { offline: false });
    api.fetchNotificationPreferences.mockResolvedValueOnce(answer({ [G]: 'none' }));
    await notificationPreferences.load();
    notificationPreferences.bind('account-a', { offline: true });
    expect(notificationPreferences.source).toBe('persisted');
    expect(notificationPreferences.groupLevel(G)).toBe('none');
    expect(await notificationPreferences.answered()).toEqual({
      kind: 'unanswered',
      source: 'persisted',
    });
    notificationPreferences.bind('account-b', { offline: true });
    expect(notificationPreferences.source).toBe('default');
    expect(notificationPreferences.groupLevel(G)).toBe('all');
  });

  it('keeps a level saved on this device in the copy', async () => {
    notificationPreferences.bind('account-a', { offline: false });
    api.fetchNotificationPreferences.mockResolvedValueOnce(answer({}));
    await notificationPreferences.load();
    await notificationPreferences.setGroupLevel(G, 'mentions');
    notificationPreferences.bind('account-a', { offline: true });
    expect(notificationPreferences.groupLevel(G)).toBe('mentions');
  });
});
