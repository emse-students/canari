// @vitest-environment happy-dom
/**
 * "VOIR LE FORMULAIRE" ON A DRAFT OPENS A PREVIEW THAT SENDS NOTHING (owner, 2026-11-08).
 *
 * The questions are drawn, the preview is said, the send button is shut, and no reader-state call is
 * made (a draft's check answers as for an absent form). A published form opened without the flag is
 * the live page, sendable.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';

const route = vi.hoisted(() => ({
  page: { params: { id: 'f1' }, url: new URL('https://canari.test/forms/f1'), state: {} },
}));
vi.mock('$app/state', () => route);
vi.mock('$app/navigation', () => ({ goto: vi.fn(async () => {}) }));
vi.mock('$lib/stores/user', () => ({
  currentUserId: () => 'u1',
  getSavedDisplayName: () => 'Ada',
}));
vi.mock('$lib/stores/auth', () => ({ getToken: () => Promise.resolve('token') }));
vi.mock('$lib/associations/activePaymentProvider.svelte', () => ({
  activePaymentProvider: { current: 'lydia' },
  loadActivePaymentProvider: () => Promise.resolve(),
}));
vi.mock('$lib/posts/useFormReminder.svelte', () => ({
  useFormReminder: () => ({ load: () => Promise.resolve(), active: false }),
}));
vi.mock('$lib/associations/api', async (orig) => ({
  ...(await orig<typeof import('$lib/associations/api')>()),
  getCalendarEventLinkedToForm: () => Promise.resolve({ linkedEvent: null }),
  getAssociation: () => Promise.reject(new Error('unused')),
}));
const api = vi.hoisted(() => ({
  status: 'draft' as 'draft' | 'published',
  checkSubmission: vi.fn(() =>
    Promise.resolve({
      hasSubmitted: false,
      formFull: false,
      pricing: null,
      hiddenItemIds: [],
      maySubmit: true,
    })
  ),
  submitForm: vi.fn(),
}));
vi.mock('$lib/forms/api', async (orig) => ({
  ...(await orig<typeof import('$lib/forms/api')>()),
  getForm: () =>
    Promise.resolve({
      id: 'f1',
      title: 'Soiree',
      description: '',
      status: api.status,
      items: [{ id: 'q1', label: 'Nom', required: false, type: 'short_text' }],
      currency: 'eur',
      basePrice: 0,
      allowCashPayment: false,
      isPublic: false,
    }),
  checkSubmission: api.checkSubmission,
  submitForm: api.submitForm,
}));

import Page from './+page.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

async function open(url: string) {
  route.page.url = new URL(url);
  const app = mount(Page, { target: document.body });
  mounted.push(() => unmount(app));
  for (let i = 0; i < 8; i++) {
    await tick();
    await Promise.resolve();
    flushSync();
  }
}

const sendButton = () =>
  [...document.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(m.form_preview_submit_disabled())
  );

describe('the fill page as a preview', () => {
  it('a draft: the preview is said, the questions drawn, the send shut, nothing asked or sent', async () => {
    api.status = 'draft';
    await open('https://canari.test/forms/f1?preview=1');
    expect(document.querySelector('[data-testid="form-preview-banner"]')).not.toBeNull();
    expect(document.body.textContent).toContain('Nom');
    const send = sendButton()!;
    expect(send.disabled).toBe(true);
    send.click();
    expect(api.submitForm).not.toHaveBeenCalled();
    expect(api.checkSubmission).not.toHaveBeenCalled();
  });

  it('a published form opened WITH the flag by a respondent: still the live page, sendable', async () => {
    api.status = 'published';
    await open('https://canari.test/forms/f1?preview=1');
    expect(document.querySelector('[data-testid="form-preview-banner"]')).toBeNull();
    expect(sendButton()).toBeUndefined();
    expect(api.checkSubmission).toHaveBeenCalledTimes(1);
  });

  it('a published form opened without the flag: the live page, no preview', async () => {
    api.status = 'published';
    await open('https://canari.test/forms/f1');
    expect(document.querySelector('[data-testid="form-preview-banner"]')).toBeNull();
    expect(sendButton()).toBeUndefined();
    expect(api.checkSubmission).toHaveBeenCalledTimes(1);
  });
});
