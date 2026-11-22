// @vitest-environment happy-dom
/**
 * "REPRENDRE LE PAIEMENT" (owner decision of 2026-11-21): the form page offers to pay a released
 * answer again - the SAME answer, a new Lydia request - when the server names it (`resumable` of
 * `GET forms/:id/check`), and only then; the tap hands the payer to Lydia like a new answer's
 * checkout, and a refusal is worded from its code.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';
import { SocialApiError } from '$lib/associations/api';
import { PAYMENT_IN_PROGRESS } from '$lib/associations/paymentRefusal';

const api = vi.hoisted(() => ({
  check: null as unknown as () => Promise<Record<string, unknown>>,
  resume: null as unknown as (id: string, body: unknown) => Promise<Record<string, unknown>>,
  form: {} as Record<string, unknown>,
}));
const opened = vi.hoisted(() => [] as string[]);

vi.mock('$app/state', async () => ({
  page: {
    get params() {
      return routeParams.current;
    },
    url: new URL('https://canari.test/forms/f1'),
    state: {},
  },
}));
vi.mock('$lib/stores/user', () => ({
  currentUserId: () => 'u1',
  getSavedDisplayName: () => 'Payer',
}));
vi.mock('$lib/stores/auth', () => ({ getToken: () => Promise.resolve('token') }));
vi.mock('$lib/associations/activePaymentProvider.svelte', () => ({
  // Not Lydia: the payer-address prompt is another test's subject.
  activePaymentProvider: { current: 'test' },
  loadActivePaymentProvider: () => Promise.resolve(),
}));
vi.mock('$lib/posts/useFormReminder.svelte', () => ({
  useFormReminder: () => ({ load: () => Promise.resolve(), active: false }),
}));
vi.mock('$lib/utils/checkoutCallbacks', () => ({
  isMobileTauri: () => true,
  formCheckoutCallbacks: () => ({}),
}));
vi.mock('$lib/utils/openExternal', () => ({
  navigateExternal: (url: string) => {
    opened.push(url);
    return Promise.resolve();
  },
}));
vi.mock('$lib/associations/api', async (orig) => ({
  ...(await orig<typeof import('$lib/associations/api')>()),
  getCalendarEventLinkedToForm: () => Promise.resolve({ linkedEvent: null }),
  getAssociation: () => Promise.reject(new Error('unused')),
}));
vi.mock('$lib/forms/api', async (orig) => ({
  ...(await orig<typeof import('$lib/forms/api')>()),
  getForm: (id: string) =>
    Promise.resolve({
      id,
      title: `Form ${id}`,
      description: '',
      items: [],
      currency: 'eur',
      basePrice: 1000,
      allowCashPayment: false,
      isPublic: false,
      ...api.form,
    }),
  checkSubmission: () => api.check(),
  getSubmission: () => Promise.resolve(null),
  resumeSubmissionPayment: (id: string, body: unknown) => api.resume(id, body),
  confirmSubmissionPayment: () => Promise.resolve({ paymentStatus: 'pending', formId: 'f1' }),
}));

import Page from './+page.svelte';
import { routeParams } from '../../../test/stubs/routePageStub.svelte';

const fresh = {
  hasSubmitted: false,
  formFull: false,
  pricing: null,
  cursusSlices: [{ pricing: null, productGridPrices: {} }],
  hiddenItemIds: [],
  maySubmit: true,
};
const offered = { ...fresh, resumable: { submissionId: 'ans', amountCents: 1500 } };
const mounted: (() => void)[] = [];

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  routeParams.current = { id: 'f1' };
  opened.length = 0;
  api.form = {};
  api.check = () => Promise.resolve({ ...offered });
  api.resume = vi.fn(() =>
    Promise.resolve({ checkoutUrl: 'https://lydia.test/pay/2', submissionId: 'ans' })
  );
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function settle() {
  for (let i = 0; i < 10; i++) {
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

const card = () => document.querySelector('[data-testid="form-payment-resume"]');
const resumeButton = () =>
  [...(card()?.querySelectorAll('button') ?? [])].find((b) =>
    b.textContent?.includes(m.form_view_payment_resume_button())
  );

describe('the form page offers to resume a released payment', () => {
  it('shows the action with the answer amount when the server names one', async () => {
    await render();
    expect(card()).not.toBeNull();
    expect(card()!.textContent).toContain('15,00');
    expect(resumeButton()).toBeDefined();
  });

  it.each([
    ['the server names none', { ...fresh, resumable: null }],
    ['an older server sends no field', { ...fresh }],
    ['the payment is in progress', { ...fresh, hasSubmitted: true, paymentStatus: 'pending' }],
    ['the answer is paid', { ...fresh, hasSubmitted: true, paymentStatus: 'paid' }],
  ])('shows nothing when %s', async (_why, check) => {
    api.check = () => Promise.resolve(check);
    await render();
    expect(card()).toBeNull();
  });

  it('shows nothing while online payments are paused', async () => {
    api.form = { paymentsPaused: true };
    await render();
    expect(card()).toBeNull();
  });

  it('pays the SAME answer again through Lydia, and then says it is in progress', async () => {
    await render();
    resumeButton()!.click();
    await settle();
    expect(api.resume).toHaveBeenCalledWith('ans', {});
    expect(opened).toEqual(['https://lydia.test/pay/2']);
    expect(card()).toBeNull();
    expect(document.querySelector('[data-payment-in-progress]')).not.toBeNull();
  });

  it('words a payment already in progress from its code, and reads the offer again', async () => {
    let checks = 0;
    api.check = () =>
      Promise.resolve(checks++ === 0 ? { ...offered } : { ...fresh, resumable: null });
    api.resume = vi.fn(() =>
      Promise.reject(
        new SocialApiError(
          'A payment of this answer is already in progress.',
          PAYMENT_IN_PROGRESS,
          409
        )
      )
    );
    await render();
    resumeButton()!.click();
    await settle();
    expect(document.body.textContent).toContain(m.form_payment_resume_in_progress());
    expect(checks).toBe(2);
    expect(card()).toBeNull();
    expect(opened).toEqual([]);
  });

  it('sends the member to fill the form again when the price changed since', async () => {
    let checks = 0;
    api.check = () =>
      Promise.resolve(checks++ === 0 ? { ...offered } : { ...fresh, resumable: null });
    api.resume = vi.fn(() =>
      Promise.reject(new SocialApiError('price changed', 'PAYMENT_PRICE_CHANGED', 409))
    );
    await render();
    resumeButton()!.click();
    await settle();
    expect(document.body.textContent).toContain(m.form_payment_resume_price_changed());
    expect(card()).toBeNull();
    expect(opened).toEqual([]);
  });
});
