// @vitest-environment happy-dom
/**
 * A PAYMENT PAID FOR AND NOT GRANTED IS CLOSED FROM THE PURCHASES LIST (migration 113). An open one
 * offers "Mark refunded" and "Mark granted"; each asks an in-app confirmation (never the browser's
 * own), records the outcome, and the row then shows it - the "Not granted" mark stays. A refusal is
 * worded from its typed code.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { Association, AssociationPurchase } from '$lib/associations/api';
import { SocialApiError } from '$lib/associations/api';
import { m } from '$lib/paraglide/messages';
import { grantRefusalMessage } from '$lib/associations/purchaseClosing';
import { flushMacrotask } from '../../../../test/flush';
import { adoptTransitionAnimations } from '../../../../test/adoptTransitionAnimations';

// The product picker's panel plays an outro when an option is chosen.
afterAll(adoptTransitionAnimations());

const state = vi.hoisted(() => ({
  rows: [] as unknown[],
  products: [] as unknown[],
  confirm: true,
  confirmed: [] as string[],
  close: vi.fn(),
  quote: vi.fn(),
  grant: vi.fn(),
}));

vi.mock('$lib/associations/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/associations/api')>()),
  listAssociationProductsForManage: vi.fn(() => Promise.resolve(state.products)),
  listAssociationPurchases: vi.fn(() => Promise.resolve(state.rows)),
  closePaidNotGranted: state.close,
  quoteCashSale: state.quote,
  grantProductPurchase: state.grant,
}));

vi.mock('$lib/utils/apiFetch', () => ({
  // The beneficiary search: one candidate, Rita.
  apiFetch: vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify([{ id: 'user-r', displayName: 'Rita' }]), { status: 200 })
    )
  ),
}));

vi.mock('$lib/stores/confirm.svelte', () => ({
  showConfirm: vi.fn((message: string) => {
    state.confirmed.push(message);
    return Promise.resolve(state.confirm);
  }),
}));

import EditAchatsTab from './EditAchatsTab.svelte';
import { pickUser } from '../../../../test/pickUser';
import { formatAmount } from '$lib/forms/fillAnswers';

const open: AssociationPurchase = {
  id: 'rec-1',
  userId: 'user-1',
  source: 'product',
  productId: 'prod-1',
  formId: null,
  productName: 'Avec alcool',
  amountCents: 3000,
  paymentMethod: 'online',
  paidAt: '2026-10-27T10:00:00.000Z',
  firstName: 'Alice',
  lastName: 'Martin',
  notGranted: true,
  closedOutcome: null,
  closedAt: null,
  grantRefusal: null,
  buyerTier: null,
};

const mounted: (() => void)[] = [];
afterEach(() => {
  mounted.splice(0).forEach((f) => f());
  document.body.innerHTML = '';
  state.close.mockReset();
  state.quote.mockReset();
  state.grant.mockReset();
  state.products = [];
  state.confirmed = [];
  state.confirm = true;
});

async function render(rows: AssociationPurchase[]): Promise<HTMLElement> {
  state.rows = rows;
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(EditAchatsTab, {
    target,
    props: { asso: { id: 'asso-1' } as unknown as Association },
  });
  mounted.push(() => void unmount(app));
  await flushMacrotask();
  flushSync();
  return target;
}

const button = (target: HTMLElement, label: string) =>
  [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);

async function settle() {
  await flushMacrotask();
  await flushMacrotask();
  flushSync();
}

describe('EditAchatsTab, closing a payment paid for and not granted', () => {
  it('offers both outcomes on an open marked payment, and none on a closed one', async () => {
    const target = await render([
      open,
      { ...open, id: 'rec-2', closedOutcome: 'refunded', closedAt: '2026-10-27T11:00:00.000Z' },
    ]);
    const labelled = (label: string) =>
      [...target.querySelectorAll('button')].filter((b) => b.textContent?.trim() === label);
    // One pair, for the ONE open row.
    expect(labelled(m.asso_achats_close_refunded_button())).toHaveLength(1);
    expect(labelled(m.asso_achats_close_granted_button())).toHaveLength(1);
    expect(target.textContent).toContain(m.asso_achats_closed_refunded());
  });

  it('records REFUNDED after an in-app confirmation, then shows the outcome and keeps the mark', async () => {
    state.close.mockResolvedValue({
      ...open,
      closedOutcome: 'refunded',
      closedAt: '2026-10-27T11:00:00.000Z',
    });
    const target = await render([open]);

    button(target, m.asso_achats_close_refunded_button())!.click();
    await settle();

    expect(state.confirmed).toHaveLength(1);
    expect(state.close).toHaveBeenCalledWith('asso-1', 'rec-1', 'refunded', false);
    expect(target.textContent).toContain(m.asso_achats_closed_refunded());
    expect(target.textContent).toContain(m.asso_achats_not_granted());
    expect(button(target, m.asso_achats_close_granted_button())).toBeUndefined();
  });

  it.each([
    [false, m.asso_achats_close_granted_confirm({ buyer: 'Alice Martin', item: 'Avec alcool' })],
    [true, m.asso_achats_close_delivered_confirm({ buyer: 'Alice Martin', item: 'Avec alcool' })],
  ])(
    'asks a GRANTED confirmation that says what it does (delivered: %s)',
    async (delivered, message) => {
      state.confirm = false;
      const target = await render([{ ...open, delivered }]);

      button(target, m.asso_achats_close_granted_button())!.click();
      await settle();

      expect(state.confirmed).toEqual([message]);
    }
  );

  it('sends what the list showed with a GRANTED closing, so the server can refuse a change', async () => {
    state.close.mockResolvedValue({ ...open, closedOutcome: 'granted', closedAt: open.paidAt });
    const target = await render([{ ...open, delivered: true }]);

    button(target, m.asso_achats_close_granted_button())!.click();
    await settle();

    expect(state.close).toHaveBeenCalledWith('asso-1', 'rec-1', 'granted', true);
  });

  it('records nothing when the confirmation is declined', async () => {
    state.confirm = false;
    const target = await render([open]);

    button(target, m.asso_achats_close_granted_button())!.click();
    await settle();

    expect(state.close).not.toHaveBeenCalled();
  });

  it('re-reads the list on a 409, so the row shows what the server holds, and words the refusal', async () => {
    state.close.mockRejectedValue(new SocialApiError('closed', 'PURCHASE_ALREADY_CLOSED', 409));
    const target = await render([open]);
    // Someone else closed it meanwhile: the server's list now carries the outcome.
    state.rows = [{ ...open, closedOutcome: 'refunded', closedAt: '2026-10-27T11:00:00.000Z' }];

    button(target, m.asso_achats_close_granted_button())!.click();
    await settle();

    expect(state.close).toHaveBeenCalledWith('asso-1', 'rec-1', 'granted', false);
    expect(target.textContent).toContain(m.asso_achats_close_already());
    expect(target.textContent).toContain(m.asso_achats_closed_refunded());
    expect(button(target, m.asso_achats_close_granted_button())).toBeUndefined();
  });

  it('logs a failure that is not a 409 as an error, and does not re-read the list', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    state.close.mockRejectedValue(new Error('network down'));
    const target = await render([open]);
    state.rows = [];

    button(target, m.asso_achats_close_refunded_button())!.click();
    await settle();

    expect(error).toHaveBeenCalled();
    expect(button(target, m.asso_achats_close_refunded_button())).toBeDefined();
    error.mockRestore();
  });

  it.each([
    'buyer-erased',
    'tier-gone',
    'year-over',
    'target-held',
    'not-a-rise',
    'not-comparable',
    'held-tier-deleted',
  ] as const)(
    'offers only "Mark refunded" when the server would refuse the grant (%s), and says why',
    async (grantRefusal) => {
      const target = await render([{ ...open, grantRefusal, buyerTier: 'Avec alcool' }]);

      expect(button(target, m.asso_achats_close_refunded_button())).toBeDefined();
      expect(button(target, m.asso_achats_close_granted_button())).toBeUndefined();
      expect(target.textContent).toContain(grantRefusalMessage(grantRefusal));
    }
  );

  it('shows the tier the buyer holds now beside an open payment', async () => {
    const target = await render([{ ...open, buyerTier: 'Sans alcool' }]);
    expect(target.textContent).toContain(m.asso_achats_buyer_tier({ tier: 'Sans alcool' }));
    expect(button(target, m.asso_achats_close_granted_button())).toBeDefined();
  });

  it('names no tier, held or not, for an erased buyer', async () => {
    const target = await render([{ ...open, grantRefusal: 'buyer-erased' }]);
    expect(target.textContent).not.toContain(m.asso_achats_buyer_tier_none());
  });
});

/**
 * A CASH SALE SHOWS THE AMOUNT IT WILL RECORD, AND THE CASHIER MAY TYPE ANOTHER (user, 2026-10-29).
 * The default is the server's quote for the chosen pair - the preferential price when the
 * beneficiary qualifies - and a typed amount is sent as the override.
 */
describe('EditAchatsTab, the amount a cash sale records', () => {
  const sweat = { id: 'prod-1', name: 'Sweat', type: 'other', amountCents: 1000 };

  /**
   * The submit event the form answers, dispatched directly: happy-dom reports every value of a
   * `step="0.01"` number field as a step mismatch (10, 3 and 2.5 all read `stepMismatch`), so
   * `requestSubmit` would refuse a valid amount.
   */
  const submit = (target: HTMLElement) =>
    target
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

  async function choosePair(target: HTMLElement) {
    await pickUser('grant-user', 'Ri');
    (target.querySelector('#grant-product') as HTMLButtonElement).click();
    flushSync();
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (o) => o.textContent?.trim() === 'Sweat'
    )!;
    option.click();
    await settle();
  }

  it('shows the preferential amount the server quotes, and records it when nothing is typed', async () => {
    state.products = [sweat];
    state.quote.mockResolvedValue({ kind: 'priced', amountCents: 300, preferential: true });
    state.grant.mockResolvedValue({});
    const target = await render([]);

    await choosePair(target);

    expect(state.quote).toHaveBeenCalledWith('asso-1', 'prod-1', 'user-r');
    expect(target.querySelector('[data-testid="grant-quote"]')?.textContent?.trim()).toBe(
      m.asso_achats_grant_quote_preferential({ amount: formatAmount(300) })
    );
    const amount = target.querySelector('#grant-amount') as HTMLInputElement;
    expect(amount.required).toBe(false);

    submit(target);
    await settle();
    expect(state.grant).toHaveBeenCalledWith('asso-1', 'prod-1', { userId: 'user-r' });
  });

  it('sends a typed amount as the override of the quoted default', async () => {
    state.products = [sweat];
    state.quote.mockResolvedValue({ kind: 'priced', amountCents: 300, preferential: true });
    state.grant.mockResolvedValue({});
    const target = await render([]);

    await choosePair(target);
    const amount = target.querySelector('#grant-amount') as HTMLInputElement;
    amount.value = '10';
    amount.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();

    submit(target);
    await settle();
    expect(state.grant).toHaveBeenCalledWith('asso-1', 'prod-1', {
      userId: 'user-r',
      amountCents: 1000,
    });
  });

  it('requires a typed amount when the grid does not sell to this beneficiary, and says so', async () => {
    state.products = [sweat];
    state.quote.mockResolvedValue({ kind: 'not-sold' });
    const target = await render([]);

    await choosePair(target);

    expect(target.textContent).toContain(m.asso_achats_grant_quote_not_sold());
    expect((target.querySelector('#grant-amount') as HTMLInputElement).required).toBe(true);
  });
});
