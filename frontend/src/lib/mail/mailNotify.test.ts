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
const nav = vi.hoisted(() => ({ goto: vi.fn() }));
vi.mock('$app/navigation', () => nav);
vi.mock('$app/paths', () => ({ resolve: (p: string) => p }));
type Raised = { notifId: number; tag: string; title: string; body: string; open: () => void };
const builder = vi.hoisted(() => ({ raised: [] as unknown[], allowed: true }));
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalNotifs: {
    sendMailNotification: async (n: unknown) => {
      if (!builder.allowed) return false;
      builder.raised.push(n);
      return true;
    },
  },
}));
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => 'granted'),
  sendNotification: vi.fn(),
}));

import { MAX_SINGLE_NOTICES, mailNotice, postMailNotices } from './mailNotify';
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
  builder.raised = [];
  builder.allowed = true;
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
    const postMessage = vi.fn();
    (window as unknown as { canariMail: unknown }).canariMail = { postMessage };
    const plugin = await import('@tauri-apps/plugin-notification');
    await postMailNotices([mail(), mail({ id: '11516', conversationId: '-11516' })]);
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(JSON.parse(postMessage.mock.calls[0][0])).toEqual({
      op: 'notify',
      itemId: 11515,
      title: 'La Prof',
      body: 'Examen de jeudi',
      publicTitle: 'Nouveau mail',
      link: 'fr.emse.canari://mail/-11515',
    });
    expect(plugin.sendNotification).not.toHaveBeenCalled();
  });

  it(`beyond ${MAX_SINGLE_NOTICES} mails, ONE summary says how many and opens the inbox`, async () => {
    const flood = Array.from({ length: MAX_SINGLE_NOTICES + 1 }, (_, i) =>
      mail({ id: String(200 + i), conversationId: `-${200 + i}` })
    );
    await postMailNotices(flood);
    const raised = builder.raised as Raised[];
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({
      tag: 'canari-mail-summary',
      title: `${MAX_SINGLE_NOTICES + 1} nouveaux mails`,
      body: 'Dans ta boîte de réception',
    });
    raised[0].open();
    expect(nav.goto).toHaveBeenCalledWith(expect.stringMatching(/(^|\/)mail$/));
    // Exactly the cap is still one notice each.
    builder.raised = [];
    await postMailNotices(flood.slice(0, MAX_SINGLE_NOTICES));
    expect(builder.raised).toHaveLength(MAX_SINGLE_NOTICES);
  });

  it('on Android, the summary goes to the native builder as one op', async () => {
    runtime.android = true;
    runtime.tauri = true;
    const postMessage = vi.fn();
    (window as unknown as { canariMail: unknown }).canariMail = { postMessage };
    const flood = Array.from({ length: MAX_SINGLE_NOTICES + 2 }, (_, i) =>
      mail({ id: String(300 + i) })
    );
    await postMailNotices(flood);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(JSON.parse(postMessage.mock.calls[0][0])).toEqual({
      op: 'summary',
      count: MAX_SINGLE_NOTICES + 2,
      title: `${MAX_SINGLE_NOTICES + 2} nouveaux mails`,
      body: 'Dans ta boîte de réception',
      publicTitle: 'Nouveau mail',
      link: 'fr.emse.canari://mail',
    });
  });

  it('elsewhere, the ONE banner builder raises it, keyed by the message, and a tap opens its thread', async () => {
    const { stableNotifId } = await import('$lib/utils/stableNotifId');
    await postMailNotices([mail()]);
    const [raised] = builder.raised as Raised[];
    expect(raised).toMatchObject({
      notifId: stableNotifId('mail:11515'),
      tag: 'canari-mail-11515',
      title: 'La Prof',
      body: 'Examen de jeudi',
    });
    raised.open();
    expect(nav.goto).toHaveBeenCalledWith(expect.stringMatching(/mail\/-11515$/));
  });

  it('nothing raised without the permission, and the next mail is still tried', async () => {
    builder.allowed = false;
    await postMailNotices([mail(), mail({ id: '11516' })]);
    expect(builder.raised).toEqual([]);
  });
});
