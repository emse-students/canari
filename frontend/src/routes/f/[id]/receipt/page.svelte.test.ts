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
const answer = vi.hoisted(() => ({ confirm: vi.fn() }));

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
}));

import Page from './+page.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  mounted.splice(0).forEach((f) => f());
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  answer.confirm.mockReset();
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
});
