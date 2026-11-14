// @vitest-environment happy-dom
/**
 * CHANGING AN ANSWER (owner, 1.6.12-alpha.2, 2026-11-14): the submitted footer says "sent" and the
 * short edit action on ONE row, and the banner names the price and the payment only on a form that
 * takes a payment (`requiresPayment`, the one predicate the page already reads).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';

const state = vi.hoisted(() => ({ requiresPayment: false }));

vi.mock('$app/state', () => ({
  page: { params: { id: 'f1' }, url: new URL('https://canari.test/forms/f1'), state: {} },
}));
vi.mock('$lib/stores/user', () => ({ currentUserId: () => 'u1' }));
vi.mock('$lib/stores/auth', () => ({ getToken: () => Promise.resolve('token') }));
vi.mock('$lib/stores/appVersionCheck.svelte', async (orig) => ({
  ...(await orig<typeof import('$lib/stores/appVersionCheck.svelte')>()),
  serverFormAnswerEdit: () => true,
}));
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
      allowAnswerEdit: true,
      requiresPayment: state.requiresPayment,
    }),
  checkSubmission: () =>
    Promise.resolve({
      hasSubmitted: true,
      formFull: false,
      pricing: null,
      hiddenItemIds: [],
      maySubmit: false,
    }),
  getSubmission: () => Promise.resolve(null),
  getMyEditableAnswers: () =>
    Promise.resolve([
      {
        id: 's1',
        formId: 'f1',
        answers: {},
        totalPaid: 0,
        paymentStatus: 'none',
        createdAt: '2026-11-01T10:00:00Z',
        lockedItemIds: [],
      },
    ]),
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

async function settle() {
  for (let i = 0; i < 8; i++) {
    await tick();
    await Promise.resolve();
    flushSync();
  }
}

async function render() {
  const app = mount(Page, { target: document.body });
  mounted.push(() => unmount(app));
  await settle();
}

describe('changing a submitted answer', () => {
  it('puts the status and the short edit action in one row', async () => {
    await render();
    const edit = document.querySelector('[data-testid="form-edit-open"]')!;
    expect(edit.textContent).toContain(m.form_view_edit_answer_short());
    const row = edit.parentElement!;
    expect(row.textContent).toContain(m.form_view_response_sent());
    expect(row.className).toContain('whitespace-nowrap');
  });

  for (const paid of [false, true]) {
    it(`the banner ${paid ? 'names' : 'does not name'} the payment on a form ${paid ? 'with' : 'without'} one`, async () => {
      state.requiresPayment = paid;
      await render();
      document.querySelector<HTMLElement>('[data-testid="form-edit-open"]')!.click();
      await settle();
      const banner = document.querySelector('[data-testid="form-edit-banner"]')!.textContent ?? '';
      const sentence = m.form_view_edit_banner({ date: '' }).split('. ')[1];
      expect(banner.includes(sentence)).toBe(paid);
    });
  }
});
