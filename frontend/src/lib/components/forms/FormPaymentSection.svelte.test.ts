// @vitest-environment happy-dom
/**
 * A PAID FORM WHOSE ASSOCIATION CANNOT COLLECT ONLINE YET (owner, 2026-11-08): with cash accepted
 * that is information, not an obstacle - a note, and no "create a free form instead"; without cash it
 * is the warning it was. Online payment is the editor's choice, and can be switched off.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';
import { editorOptionState } from '$lib/forms/formOptionConflict';

vi.mock('$lib/associations/api', async (orig) => ({
  ...(await orig<typeof import('$lib/associations/api')>()),
  fetchActivePaymentProvider: () => Promise.resolve('lydia'),
}));
// The payout hint's fee schedule (docs/wiki/lydia-contract-flux.md): not configured here.
vi.mock('$lib/payments/lydiaFees', async (orig) => ({
  ...(await orig<typeof import('$lib/payments/lydiaFees')>()),
  fetchLydiaFeeSchedule: () => Promise.resolve(null),
}));
vi.mock('$lib/associations/activePaymentProvider.svelte', () => ({
  activePaymentProvider: { current: 'lydia' },
  loadActivePaymentProvider: () => Promise.resolve(),
}));

import FormPaymentSection from './FormPaymentSection.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function render(allowCashPayment: boolean) {
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(FormPaymentSection, {
    target,
    props: {
      requiresPayment: true,
      optionState: editorOptionState({
        anonymous: false,
        isPublic: false,
        requiresPayment: true,
        grantsCotisation: false,
        submitCondition: null,
        items: [],
        allowAnswerEdit: false,
      }),
      isPublic: false,
      basePrice: 10,
      allowCashPayment,
      allowOnlinePayment: true,
      cashPaymentExpiryDays: undefined,
      priceMatrix: null,
      tiers: [],
      formations: [],
      items: [],
      associationName: 'BDE',
      associationCanBePaid: false,
    },
  });
  mounted.push(() => unmount(instance));
  flushSync();
  return target;
}

describe('FormPaymentSection, online not ready', () => {
  it('cash on: a note, no warning, no "free form instead"', () => {
    const root = render(true);
    expect(root.querySelector('[data-testid="online-pending-cash-note"]')?.textContent).toContain(
      m.form_payment_online_pending_cash_note()
    );
    expect(root.textContent).not.toContain(m.form_no_payments_create_free_button());
  });

  it('cash off: the warning and its way out, no note', () => {
    const root = render(false);
    expect(root.querySelector('[data-testid="online-pending-cash-note"]')).toBeNull();
    expect(root.textContent).toContain(m.form_no_payments_create_free_button());
  });

  it('offers online payment as a switch the editor may turn off', () => {
    const root = render(true);
    expect(root.textContent).toContain(m.form_online_payment_toggle_hint());
  });
});
