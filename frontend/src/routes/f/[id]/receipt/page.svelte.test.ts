// @vitest-environment happy-dom
/**
 * THE GUEST'S RETURN FROM LYDIA (WP-P2): what it shows comes from the server, read with the receipt
 * and with nothing else from its URL.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';
import { SocialApiError } from '$lib/associations/api';

const RECEIPT = 'R'.repeat(43);
const at = vi.hoisted(() => ({ url: new URL('https://canari.test/') }));
const answer = vi.hoisted(() => ({ confirm: vi.fn(), toCash: vi.fn() }));

vi.mock('$app/state', () => ({
  page: {
    get url() {
      return at.url;
    },
    params: { id: 'f1' },
    state: {},
  },
}));
vi.mock('$lib/forms/api', async (orig) => ({
  ...(await orig<typeof import('$lib/forms/api')>()),
  confirmGuestReceipt: answer.confirm,
  switchGuestReceiptToCash: answer.toCash,
}));

import Page from './+page.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  mounted.splice(0).forEach((f) => f());
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  answer.confirm.mockReset();
  answer.toCash.mockReset();
  vi.restoreAllMocks();
});

async function render(search: string) {
  at.url = new URL(`https://canari.test/f/f1/receipt${search}`);
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(Page, { target });
  mounted.push(() => void unmount(app));
  flushSync();
  for (let i = 0; i < 5; i++) await tick();
  flushSync();
}

const text = () => document.body.textContent ?? '';

describe('the guest receipt page', () => {
  it('shows a confirmed payment with its reference and its amount, and promises no e-mail', async () => {
    answer.confirm.mockResolvedValue({
      reference: '1A2B-3C4D',
      formId: 'f1',
      totalPaid: 1200,
      currency: 'eur',
      paymentStatus: 'paid',
    });
    await render(`?receipt=${RECEIPT}`);
    expect(answer.confirm).toHaveBeenCalledWith(RECEIPT);
    expect(text()).toContain(m.form_success_confirmed_heading());
    expect(text()).toContain(m.form_guest_receipt_confirmed_desc());
    expect(text()).toContain(m.form_guest_reference({ reference: '1A2B-3C4D' }));
    expect(text()).not.toContain(m.form_success_confirmed_desc());
  });

  it('believes the server, never a URL that says it was paid', async () => {
    answer.confirm.mockResolvedValue({
      reference: '1A2B-3C4D',
      formId: 'f1',
      totalPaid: 1200,
      currency: 'eur',
      paymentStatus: 'cancelled',
      requestState: 'declined',
    });
    await render(`?receipt=${RECEIPT}&status=paid&paymentStatus=paid&submission_id=s1`);
    // Only the receipt went to the server.
    expect(answer.confirm.mock.calls).toEqual([[RECEIPT]]);
    expect(text()).toContain(m.form_success_declined_heading());
    expect(text()).not.toContain(m.form_success_confirmed_heading());
    expect(document.querySelector('a')?.getAttribute('href')).toBe('/f/f1');
  });

  it('sends no Referer, so its own requests never carry the receipt into a log', async () => {
    answer.confirm.mockResolvedValue({
      reference: '1A2B-3C4D',
      formId: 'f1',
      totalPaid: 1200,
      currency: 'eur',
      paymentStatus: 'paid',
    });
    await render(`?receipt=${RECEIPT}`);
    const policies = [...document.head.querySelectorAll('meta[name="referrer"]')].map((meta) =>
      meta.getAttribute('content')
    );
    expect(policies).toEqual(['no-referrer']);
  });

  it('asks nothing without a receipt, and says the link is not valid', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await render('?submission_id=s1');
    expect(answer.confirm).not.toHaveBeenCalled();
    expect(text()).toContain(m.form_guest_receipt_not_found_desc());
  });

  it('says a receipt the server does not know is not valid, with no reference', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    answer.confirm.mockRejectedValue(new SocialApiError('Receipt not found', null, 404));
    await render(`?receipt=${RECEIPT}`);
    expect(text()).toContain(m.form_guest_receipt_not_found_desc());
    expect(document.querySelector('[data-guest-reference]')).toBeNull();
  });

  // "PAYER EN DIRECT" (owner decision of 2026-11-23): the same answer, settled in person instead.
  describe('a failed card payment settled in person', () => {
    const declined = {
      reference: '1A2B-3C4D',
      formId: 'f1',
      totalPaid: 1200,
      currency: 'eur',
      paymentStatus: 'cancelled',
      requestState: 'declined',
    };
    const cashButton = () => document.querySelector<HTMLButtonElement>('[data-guest-cash-switch]');

    it('offers it when the server does, and switches the answer by its receipt alone', async () => {
      answer.confirm.mockResolvedValue({ ...declined, cashSwitchOffered: true });
      answer.toCash.mockResolvedValue({ ...declined, paymentStatus: 'pending_cash' });
      await render(`?receipt=${RECEIPT}`);
      expect(cashButton()).not.toBeNull();
      cashButton()!.click();
      for (let i = 0; i < 5; i++) await tick();
      flushSync();
      expect(answer.toCash.mock.calls).toEqual([[RECEIPT]]);
      expect(text()).toContain(m.form_success_cash_heading());
      expect(text()).toContain(m.form_guest_receipt_cash_desc());
      expect(text()).toContain(m.form_guest_reference({ reference: '1A2B-3C4D' }));
      expect(cashButton()).toBeNull();
    });

    it('offers nothing when the server does not, or is older and sends no field', async () => {
      answer.confirm.mockResolvedValue(declined);
      await render(`?receipt=${RECEIPT}`);
      expect(text()).toContain(m.form_success_declined_heading());
      expect(cashButton()).toBeNull();
    });

    it('words a refusal from its code', async () => {
      answer.confirm.mockResolvedValue({ ...declined, cashSwitchOffered: true });
      answer.toCash.mockRejectedValue(new SocialApiError('full', 'FORM_FULL', 409));
      await render(`?receipt=${RECEIPT}`);
      cashButton()!.click();
      for (let i = 0; i < 5; i++) await tick();
      flushSync();
      expect(document.querySelector('[role="alert"]')?.textContent).not.toBe('');
      expect(text()).toContain(m.form_success_declined_heading());
    });

    it('shows an answer already waiting for cash as such, never as not found', async () => {
      answer.confirm.mockResolvedValue({
        ...declined,
        paymentStatus: 'pending_cash',
        requestState: undefined,
      });
      await render(`?receipt=${RECEIPT}`);
      expect(text()).toContain(m.form_success_cash_heading());
      expect(text()).not.toContain(m.form_guest_receipt_not_found_desc());
    });
  });
});
