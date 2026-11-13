// @vitest-environment happy-dom
/**
 * THE NATIVE BUYER'S RETURN: the purchase button hands the payer to Lydia's page in the phone's
 * browser, says the payment is in progress, and reads the attempt ONCE each time the app comes
 * back on screen - and only about the attempt it is showing.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';
import { APP_FOREGROUND_EVENT } from '$lib/utils/appForeground';
import type { AssociationProduct } from '$lib/associations/api';

const api = vi.hoisted(() => ({
  checkout: null as unknown as () => Promise<Record<string, unknown>>,
  confirm: null as unknown as (checkoutId: string) => Promise<{ status: string }>,
}));
const opened = vi.hoisted(() => [] as string[]);
const nav = vi.hoisted(() => ({ result: null as unknown as () => Promise<void> }));

vi.mock('$lib/associations/activePaymentProvider.svelte', () => ({
  activePaymentProvider: { current: 'test' },
  loadActivePaymentProvider: () => Promise.resolve(),
}));
vi.mock('$lib/utils/checkoutCallbacks', () => ({
  isMobileTauri: () => true,
  shopCheckoutCallbacks: () => ({}),
}));
vi.mock('$lib/utils/openExternal', () => ({
  navigateExternal: (url: string) => {
    opened.push(url);
    return nav.result();
  },
}));
vi.mock('$lib/associations/api', async (orig) => ({
  ...(await orig<typeof import('$lib/associations/api')>()),
  createProductCheckout: () => api.checkout(),
  confirmProductCheckout: (_a: string, _p: string, checkoutId: string) => api.confirm(checkoutId),
}));

import Button from './ProductPurchaseButton.svelte';

const product = {
  id: 'p1',
  associationId: 'a1',
  name: 'Cotisation',
  type: 'membership',
  amountCents: 1500,
  currency: 'eur',
  allowCustomAmount: false,
} as unknown as AssociationProduct;

const mounted: (() => void)[] = [];
beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  opened.length = 0;
  nav.result = () => Promise.resolve();
  api.checkout = () =>
    Promise.resolve({ checkoutUrl: 'https://lydia.test/pay/1', checkoutId: 'c1' });
  api.confirm = vi.fn(() => Promise.resolve({ status: 'open' }));
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
  const app = mount(Button, { target: document.body, props: { product } });
  mounted.push(() => unmount(app));
  await settle();
}
const text = () => document.body.textContent ?? '';
async function leaveAndReturn() {
  window.dispatchEvent(new CustomEvent(APP_FOREGROUND_EVENT, { detail: { foreground: false } }));
  window.dispatchEvent(new CustomEvent(APP_FOREGROUND_EVENT, { detail: { foreground: true } }));
  await settle();
}
async function buy() {
  document.querySelector('button')!.click();
  await settle();
}

describe('the purchase button after handing the payer to Lydia', () => {
  it('says it is in progress, reads nothing until the app returns, then says the purchase is paid', async () => {
    await render();
    await buy();
    expect(opened).toEqual(['https://lydia.test/pay/1']);
    expect(text()).toContain(m.shop_payment_in_progress_note());
    expect(api.confirm).not.toHaveBeenCalled();

    await leaveAndReturn();
    expect(api.confirm).toHaveBeenCalledTimes(1);
    expect(text()).toContain(m.shop_payment_in_progress_note());

    api.confirm = vi.fn(() => Promise.resolve({ status: 'paid' }));
    await leaveAndReturn();
    expect(text()).toContain(m.shop_return_membership_paid());
    expect(text()).not.toContain(m.shop_payment_in_progress_note());

    // Settled: a further return reads nothing.
    await leaveAndReturn();
    expect(api.confirm).toHaveBeenCalledTimes(1);
  });

  it('keeps the note when a read fails, and a dead request says it did not go through', async () => {
    await render();
    await buy();
    api.confirm = vi.fn(() => Promise.reject(new TypeError('offline')));
    await leaveAndReturn();
    expect(text()).toContain(m.shop_payment_in_progress_note());
    api.confirm = vi.fn(() => Promise.resolve({ status: 'expired' }));
    await leaveAndReturn();
    expect(text()).toContain(m.shop_return_not_completed());
  });

  it('drops a read that lands after a newer purchase replaced its attempt', async () => {
    await render();
    await buy();
    let late!: (a: { status: string }) => void;
    api.confirm = vi.fn(() => new Promise<{ status: string }>((done) => (late = done)));
    await leaveAndReturn();
    // The payer buys again before the first read answered: a new attempt, a new reader.
    api.checkout = () =>
      Promise.resolve({ checkoutUrl: 'https://lydia.test/pay/2', checkoutId: 'c2' });
    await buy();
    late({ status: 'paid' });
    await settle();
    expect(text()).toContain(m.shop_payment_in_progress_note());
    expect(text()).not.toContain(m.shop_return_membership_paid());
  });

  it('keeps the watch when the hand-off rejects after the browser opened', async () => {
    nav.result = () => Promise.reject(new Error('openUrl failed'));
    await render();
    await buy();
    expect(text()).toContain(m.shop_payment_in_progress_note());
    api.confirm = vi.fn(() => Promise.resolve({ status: 'paid' }));
    await leaveAndReturn();
    expect(text()).toContain(m.shop_return_membership_paid());
  });

  it('keeps the watch when the app returns before the hand-off call resolves', async () => {
    let resolveNav!: () => void;
    nav.result = () => new Promise<void>((done) => (resolveNav = done));
    api.confirm = vi.fn(() => Promise.resolve({ status: 'paid' }));
    await render();
    await buy();
    await leaveAndReturn();
    resolveNav();
    await settle();
    expect(api.confirm).toHaveBeenCalledTimes(1);
    expect(text()).toContain(m.shop_return_membership_paid());
  });

  it('offers no second purchase of a product that cannot be repeated once it is paid', async () => {
    await render();
    await buy();
    api.confirm = vi.fn(() => Promise.resolve({ status: 'paid' }));
    await leaveAndReturn();
    expect(document.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
  });
});
