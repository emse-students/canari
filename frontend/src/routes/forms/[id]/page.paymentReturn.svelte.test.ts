// @vitest-environment happy-dom
/**
 * THE NATIVE PAYER'S RETURN (owner, production, Android 1.6.10, 2026-11-13): the payer paid on
 * Lydia's page in the phone's browser, came back to Canari BY HAND, and found the form exactly as
 * before paying. The page now keeps the checkout, says it is in progress, and reads the answer once
 * each time the app comes back on screen - and only ever about the checkout it is showing.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';
import { APP_FOREGROUND_EVENT } from '$lib/utils/appForeground';

type Answer = { paymentStatus: string; requestState?: string; formId: string };

const api = vi.hoisted(() => ({
  check: null as unknown as () => Promise<Record<string, unknown>>,
  confirm: null as unknown as (id: string) => Promise<Answer>,
  submit: null as unknown as () => Promise<Record<string, unknown>>,
}));
const opened = vi.hoisted(() => [] as string[]);
const nav = vi.hoisted(() => ({ result: null as unknown as () => Promise<void> }));

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
    return nav.result();
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
    }),
  checkSubmission: () => api.check(),
  getSubmission: () => Promise.resolve(null),
  submitForm: () => api.submit(),
  confirmSubmissionPayment: (id: string) => api.confirm(id),
}));

import Page from './+page.svelte';
import { routeParams } from '../../../test/stubs/routePageStub.svelte';

const fresh = {
  hasSubmitted: false,
  formFull: false,
  pricing: null,
  hiddenItemIds: [],
  maySubmit: true,
};
const mounted: (() => void)[] = [];

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  routeParams.current = { id: 'f1' };
  opened.length = 0;
  nav.result = () => Promise.resolve();
  api.check = () => Promise.resolve({ ...fresh });
  api.submit = () =>
    Promise.resolve({ checkoutUrl: 'https://lydia.test/pay/1', submissionId: 's1' });
  api.confirm = vi.fn(() => Promise.resolve({ paymentStatus: 'pending', formId: 'f1' }));
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
  let alive = true;
  const stop = () => {
    if (alive) unmount(app);
    alive = false;
  };
  mounted.push(stop);
  await settle();
  return stop;
}

const text = () => document.body.textContent ?? '';

/** The phone's shell leaving and coming back: the `canari:foreground` edges `onAppScreenChange` reads. */
async function leaveAndReturn() {
  window.dispatchEvent(new CustomEvent(APP_FOREGROUND_EVENT, { detail: { foreground: false } }));
  window.dispatchEvent(new CustomEvent(APP_FOREGROUND_EVENT, { detail: { foreground: true } }));
  await settle();
}

async function pay() {
  const button = [...document.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('10,00')
  )!;
  button.click();
  await settle();
}

describe('the form page after handing the payer to Lydia', () => {
  it('says the payment is in progress, then confirmed once the app comes back and it is paid', async () => {
    await render();
    await pay();
    expect(opened).toEqual(['https://lydia.test/pay/1']);
    expect(text()).toContain(m.form_view_payment_in_progress_note());
    expect(text()).toContain(m.form_view_payment_reopen());
    expect(api.confirm).not.toHaveBeenCalled();

    api.confirm = vi.fn(() => Promise.resolve({ paymentStatus: 'paid', formId: 'f1' }));
    await leaveAndReturn();
    expect(api.confirm).toHaveBeenCalledExactlyOnceWith('s1');
    expect(text()).toContain(m.form_success_confirmed_heading());
    expect(text()).not.toContain(m.form_view_payment_in_progress_note());
  });

  it('keeps the watch when the hand-off rejects after the browser opened', async () => {
    nav.result = () => Promise.reject(new Error('openUrl failed'));
    await render();
    await pay();
    expect(text()).toContain(m.form_view_payment_in_progress_note());
    api.confirm = vi.fn(() => Promise.resolve({ paymentStatus: 'paid', formId: 'f1' }));
    await leaveAndReturn();
    expect(text()).toContain(m.form_success_confirmed_heading());
  });

  it('keeps the watch when the app returns before the hand-off call resolves', async () => {
    let resolveNav!: () => void;
    nav.result = () => new Promise<void>((done) => (resolveNav = done));
    api.confirm = vi.fn(() => Promise.resolve({ paymentStatus: 'paid', formId: 'f1' }));
    await render();
    await pay();
    await leaveAndReturn();
    resolveNav();
    await settle();
    expect(api.confirm).toHaveBeenCalledTimes(1);
    expect(text()).toContain(m.form_success_confirmed_heading());
  });

  it('keeps "in progress" with the reopen button while still pending, and reopens Lydia', async () => {
    await render();
    await pay();
    await leaveAndReturn();
    expect(api.confirm).toHaveBeenCalledTimes(1);
    expect(text()).toContain(m.form_view_payment_in_progress_note());
    const reopen = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === m.form_view_payment_reopen()
    )!;
    reopen.click();
    await settle();
    expect(opened).toEqual(['https://lydia.test/pay/1', 'https://lydia.test/pay/1']);
  });

  it('a declined request releases the answer: the retry note, and the pay button again', async () => {
    await render();
    await pay();
    api.confirm = vi.fn(() =>
      Promise.resolve({ paymentStatus: 'cancelled', requestState: 'declined', formId: 'f1' })
    );
    await leaveAndReturn();
    expect(text()).toContain(m.form_view_payment_declined_note());
    expect(text()).not.toContain(m.form_view_payment_in_progress_note());
    const payButton = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('10,00')
    )!;
    expect(payButton.disabled).toBe(false);
  });

  it('a final unpaid state leaves the in-progress block, and asks nothing more on return', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    await render();
    await pay();
    api.confirm = vi.fn(() => Promise.resolve({ paymentStatus: 'cancelled', formId: 'f1' }));
    await leaveAndReturn();
    expect(text()).not.toContain(m.form_view_payment_in_progress_note());
    await leaveAndReturn();
    expect(api.confirm).toHaveBeenCalledTimes(1);
  });

  it('stops listening once the page is gone', async () => {
    const stop = await render();
    await pay();
    stop();
    await leaveAndReturn();
    expect(api.confirm).not.toHaveBeenCalled();
  });
});

describe('a pending answer found on load', () => {
  it('is read once on load, and not again on a return while that read is in flight', async () => {
    let answer!: (a: Answer) => void;
    api.check = () =>
      Promise.resolve({
        ...fresh,
        hasSubmitted: true,
        paymentStatus: 'pending',
        submissionId: 's1',
      });
    api.confirm = vi.fn(() => new Promise<Answer>((done) => (answer = done)));
    await render();
    expect(api.confirm).toHaveBeenCalledTimes(1);
    await leaveAndReturn();
    expect(api.confirm).toHaveBeenCalledTimes(1);
    answer({ paymentStatus: 'paid', formId: 'f1' });
    await settle();
    expect(text()).toContain(m.form_success_confirmed_heading());
  });

  it('a load read that lands after the page moved to another form is dropped', async () => {
    let answer!: (a: Answer) => void;
    api.check = () =>
      Promise.resolve({
        ...fresh,
        hasSubmitted: true,
        paymentStatus: 'pending',
        submissionId: 's1',
      });
    api.confirm = vi.fn(() => new Promise<Answer>((done) => (answer = done)));
    await render();
    expect(text()).toContain('Form f1');

    // Form A -> form B: the component is reused, B has no answer.
    api.check = () => Promise.resolve({ ...fresh });
    routeParams.current = { id: 'f2' };
    await settle();
    expect(text()).toContain('Form f2');

    answer({ paymentStatus: 'cancelled', requestState: 'declined', formId: 'f1' });
    await settle();
    expect(text()).not.toContain(m.form_view_payment_declined_note());
    expect(text()).not.toContain(m.form_success_confirmed_heading());
  });
});
