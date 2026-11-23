// @vitest-environment happy-dom
/**
 * THE WAITING LIST ON THE FORM PAGE (owner decision of 2026-11-23): a full form whose list is open
 * offers to join it instead of "Complet"; an answer in line shows its rank and the way out of the
 * list; a promoted answer owing its payment is paid through "Reprendre le paiement".
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';

const api = vi.hoisted(() => ({
  check: null as unknown as () => Promise<Record<string, unknown>>,
  resume: null as unknown as (id: string, body: unknown) => Promise<Record<string, unknown>>,
  submit: null as unknown as (
    id: string,
    body: Record<string, unknown>
  ) => Promise<Record<string, unknown>>,
  leave: null as unknown as (id: string) => Promise<void>,
  form: {} as Record<string, unknown>,
}));
const opened = vi.hoisted(() => [] as string[]);
const confirmAnswer = vi.hoisted(() => ({ value: true }));
vi.mock('$lib/stores/confirm.svelte', () => ({
  showConfirm: () => Promise.resolve(confirmAnswer.value),
}));

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
  submitForm: (id: string, body: Record<string, unknown>) => api.submit(id, body),
  leaveWaitlist: (id: string) => api.leave(id),
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
const fullWithList = { ...fresh, formFull: true, waitlist: { open: true, rank: null } };
const mounted: (() => void)[] = [];

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  routeParams.current = { id: 'f1' };
  opened.length = 0;
  api.form = {};
  api.check = () => Promise.resolve({ ...fullWithList });
  api.resume = vi.fn(() =>
    Promise.resolve({ checkoutUrl: 'https://lydia.test/pay/2', submissionId: 'ans' })
  );
  api.submit = vi.fn(() =>
    Promise.resolve({ submissionId: 'ans', waiting: true, waitlistRank: 4 })
  );
  api.leave = vi.fn(() => Promise.resolve());
  confirmAnswer.value = true;
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

const buttonWith = (text: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
const rankCard = () => document.querySelector('[data-testid="form-waitlist-rank"]');

describe('a full form whose waiting list is open', () => {
  it('offers to join the list rather than a dead "Complet", and sends the wish', async () => {
    api.form = { basePrice: 0 };
    await render();
    const join = buttonWith(m.form_waitlist_join_button());
    expect(join).toBeDefined();
    expect(join!.disabled).toBe(false);
    join!.click();
    await settle();
    expect(api.submit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.submit).mock.calls[0][1].joinWaitlist).toBe(true);
    // In line: the rank the server gave, and the way out.
    expect(rankCard()!.textContent).toContain(m.form_waitlist_rank({ rank: 4 }));
  });

  it('never offers the list when the server keeps none (an older server, or the switch off)', async () => {
    api.check = () => Promise.resolve({ ...fresh, formFull: true });
    await render();
    expect(buttonWith(m.form_waitlist_join_button())).toBeUndefined();
    api.check = () => Promise.resolve({ ...fullWithList, waitlist: { open: false, rank: null } });
    document.body.innerHTML = '';
    await render();
    expect(buttonWith(m.form_waitlist_join_button())).toBeUndefined();
  });
});

describe('an answer waiting in line', () => {
  const waiting = {
    ...fullWithList,
    hasSubmitted: true,
    paymentStatus: 'waiting',
    submissionId: 'ans',
    waitlist: { open: true, rank: 3 },
  };

  it('shows its rank, the first place in its own words', async () => {
    api.check = () => Promise.resolve({ ...waiting });
    await render();
    expect(rankCard()!.textContent).toContain(m.form_waitlist_rank({ rank: 3 }));
    document.body.innerHTML = '';
    api.check = () => Promise.resolve({ ...waiting, waitlist: { open: true, rank: 1 } });
    await render();
    expect(rankCard()!.textContent).toContain(m.form_waitlist_rank_first());
  });

  it('leaves the list on a confirmed tap, and reads the state again', async () => {
    let calls = 0;
    api.check = () => {
      calls += 1;
      return Promise.resolve(calls === 1 ? { ...waiting } : { ...fullWithList });
    };
    await render();
    buttonWith(m.form_waitlist_leave_button())!.click();
    await settle();
    expect(api.leave).toHaveBeenCalledWith('ans');
    expect(rankCard()).toBeNull();
  });

  it('keeps its place when the member does not confirm', async () => {
    confirmAnswer.value = false;
    api.check = () => Promise.resolve({ ...waiting });
    await render();
    buttonWith(m.form_waitlist_leave_button())!.click();
    await settle();
    expect(api.leave).not.toHaveBeenCalled();
    expect(rankCard()).not.toBeNull();
  });
});

describe('a promoted answer owing its payment', () => {
  it('is paid through the resume, worded as the place that opened up, even on a closed form', async () => {
    api.form = { closedAt: '2020-01-01T00:00:00.000Z' };
    api.check = () =>
      Promise.resolve({
        ...fresh,
        formFull: true,
        hasSubmitted: true,
        paymentStatus: 'payment_due',
        submissionId: 'ans',
        resumable: { submissionId: 'ans', amountCents: 1500 },
        waitlist: { open: true, rank: null },
      });
    await render();
    const card = document.querySelector('[data-testid="form-payment-resume"]');
    expect(card!.textContent).toContain(m.form_waitlist_payment_due_title());
    buttonWith(m.form_view_payment_resume_button())!.click();
    await settle();
    expect(api.resume).toHaveBeenCalledTimes(1);
    expect(opened).toEqual(['https://lydia.test/pay/2']);
  });
});
