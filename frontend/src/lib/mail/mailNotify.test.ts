// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ android: false, tauri: false }));
vi.mock('$lib/utils/appVersion', () => ({
  isAndroidTauriRuntime: () => runtime.android,
  isIosTauriRuntime: () => false,
}));
vi.mock('$lib/utils/tauriRuntime', () => ({ isTauriRuntime: () => runtime.tauri }));
vi.mock('$lib/composables/useNotifications.svelte', () => ({
  NOTIFICATION_ICON: 'ic_notification',
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => 'granted'),
  sendNotification: vi.fn(),
}));

import { mailNotice, postMailNotices } from './mailNotify';
import type { NewMail } from './mailWatcher';

/**
 * What a new-mail notification says (lot 4): the sender and the subject in Paraglide words, never the
 * body; a lock-screen version that says neither; and a tap that opens the message's conversation.
 */

const mail = (over: Partial<NewMail> = {}): NewMail => ({
  id: '11515',
  conversationId: '-11515',
  from: { address: 'prof@emse.fr', name: 'La Prof' },
  subject: 'Examen de jeudi',
  date: 0,
  ...over,
});

beforeEach(() => {
  runtime.android = false;
  runtime.tauri = false;
});
afterEach(() => {
  delete (window as unknown as { canariMail?: unknown }).canariMail;
  vi.unstubAllGlobals();
});

describe('mailNotice', () => {
  it('is the sender and the subject, and opens the conversation', () => {
    expect(mailNotice(mail())).toEqual({
      itemId: 11515,
      title: 'La Prof',
      body: 'Examen de jeudi',
      publicTitle: 'Nouveau mail',
      route: '/mail/-11515',
      link: 'fr.emse.canari://mail/-11515',
    });
  });

  it('the lock-screen version names neither the sender nor the subject', () => {
    const notice = mailNotice(mail())!;
    expect(notice.publicTitle).not.toContain('Prof');
    expect(notice.publicTitle).not.toContain('Examen');
  });

  it('falls back to the address, then to "unknown", and to "(sans objet)"', () => {
    expect(mailNotice(mail({ from: { address: 'a@emse.fr', name: null } }))!.title).toBe(
      'a@emse.fr'
    );
    expect(mailNotice(mail({ from: null }))!.title).toBe('Expéditeur inconnu');
    expect(mailNotice(mail({ subject: '  ' }))!.body).toBe('(sans objet)');
  });

  it('a message with no conversation opens the inbox; an id of another mailbox is never shown', () => {
    expect(mailNotice(mail({ conversationId: null }))).toMatchObject({
      route: '/mail',
      link: 'fr.emse.canari://mail',
    });
    expect(mailNotice(mail({ id: 'acct:12' }))).toBeNull();
  });
});

describe('postMailNotices', () => {
  it('on Android, hands each notice to the native builder - never the plugin', async () => {
    runtime.android = true;
    runtime.tauri = true;
    const notify = vi.fn();
    (window as unknown as { canariMail: unknown }).canariMail = {
      start: vi.fn(),
      stop: vi.fn(),
      notify,
    };
    const plugin = await import('@tauri-apps/plugin-notification');
    await postMailNotices([mail(), mail({ id: '11516', conversationId: '-11516' })]);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(JSON.parse(notify.mock.calls[0][0])).toEqual({
      itemId: 11515,
      title: 'La Prof',
      body: 'Examen de jeudi',
      publicTitle: 'Nouveau mail',
      link: 'fr.emse.canari://mail/-11515',
    });
    expect(plugin.sendNotification).not.toHaveBeenCalled();
  });

  it('on the web, one browser notification per mail, tagged by the message', async () => {
    const shown: { title: string; options: NotificationOptions }[] = [];
    class FakeNotification {
      static permission = 'granted';
      onclick: (() => void) | null = null;
      constructor(title: string, options: NotificationOptions) {
        shown.push({ title, options });
      }
      close() {}
    }
    vi.stubGlobal('Notification', FakeNotification);
    await postMailNotices([mail()]);
    expect(shown).toEqual([
      { title: 'La Prof', options: { body: 'Examen de jeudi', tag: 'canari-mail-11515' } },
    ]);
  });

  it('on the web, nothing without the permission', async () => {
    const constructed = vi.fn();
    class Denied {
      static permission = 'default';
      constructor() {
        constructed();
      }
    }
    vi.stubGlobal('Notification', Denied);
    await postMailNotices([mail()]);
    expect(constructed).not.toHaveBeenCalled();
  });
});
