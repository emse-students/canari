// @vitest-environment happy-dom
/**
 * A FORM A MANAGER ENDED (#3719, read on the Mi 9T 2026-11-17): the member page used to draw it open
 * and refuse only at "Envoyer" (400 FORM_CLOSED). It now reads the SAME rule as the public page and
 * the manager's list (`isClosedForm`): the closed notice, no send button, the questions locked. An
 * end still to come is a scheduled close, not a closed form.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';

const state = vi.hoisted(() => ({ closedAt: null as string | null }));

vi.mock('$app/state', () => ({
  page: { params: { id: 'f1' }, url: new URL('https://canari.test/forms/f1'), state: {} },
}));
vi.mock('$lib/stores/user', () => ({ currentUserId: () => 'u1' }));
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
vi.mock('$lib/forms/api', async (orig) => ({
  ...(await orig<typeof import('$lib/forms/api')>()),
  getForm: () =>
    Promise.resolve({
      id: 'f1',
      title: 'Sondage',
      description: '',
      items: [{ id: 'q1', label: 'q1', required: false, type: 'text' }],
      currency: 'eur',
      basePrice: 0,
      allowCashPayment: false,
      isPublic: false,
      closedAt: state.closedAt,
    }),
  checkSubmission: () =>
    Promise.resolve({
      hasSubmitted: false,
      formFull: false,
      pricing: null,
      cursusSlices: [{ pricing: null, productGridPrices: {} }],
      hiddenItemIds: [],
      maySubmit: true,
    }),
  getSubmission: () => Promise.resolve(null),
  getMyEditableAnswers: () => Promise.resolve([]),
}));

import Page from './+page.svelte';

const mounted: (() => void)[] = [];

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function render() {
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
    (b.textContent ?? '').includes(m.form_view_submit())
  );

describe('the member form page and a form ended by hand', () => {
  it('draws the closed notice and locks the answer when the end has passed', async () => {
    state.closedAt = '2026-01-01T00:00:00.000Z';
    await render();
    expect(document.querySelector('[data-testid="form-closed-notice"]')?.textContent).toContain(
      m.form_view_closed()
    );
    const send = sendButton();
    expect(send === undefined || send.hasAttribute('disabled')).toBe(true);
  });

  it('draws the form open when the end is still to come', async () => {
    state.closedAt = '2099-01-01T00:00:00.000Z';
    await render();
    expect(document.body.textContent).not.toContain(m.form_view_closed());
    expect(sendButton()?.hasAttribute('disabled')).toBe(false);
  });

  it('draws the form open when it has no end', async () => {
    state.closedAt = null;
    await render();
    expect(document.body.textContent).not.toContain(m.form_view_closed());
  });
});
