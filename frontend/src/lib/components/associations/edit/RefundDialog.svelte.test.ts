// @vitest-environment happy-dom
/**
 * THE REFUND DIALOG'S STATES: a form (total or partial, an amount, a reason), a confirmation that
 * names what a total refund withdraws, the call, and its outcome in plain words - refunded, waiting
 * for Lydia's confirmation, or refused. The key is drawn once per dialog, so the server answers a
 * resent request with the first refund instead of refunding twice.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { AssociationPurchase, RefundStanding } from '$lib/associations/api';
import { SocialApiError } from '$lib/associations/api';
import { m } from '$lib/paraglide/messages';
import { flushMacrotask } from '../../../../test/flush';
import { adoptTransitionAnimations } from '../../../../test/adoptTransitionAnimations';

afterAll(adoptTransitionAnimations());

const state = vi.hoisted(() => ({ refund: vi.fn() }));

vi.mock('$lib/associations/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/associations/api')>()),
  refundAssociationPurchase: state.refund,
}));

import RefundDialog from './RefundDialog.svelte';

const purchase: AssociationPurchase = {
  id: 'rec-1',
  userId: 'user-1',
  source: 'product',
  productId: 'prod-1',
  formId: null,
  productName: 'Cotisation',
  amountCents: 3000,
  paymentMethod: 'online',
  paidAt: '2026-10-27T10:00:00.000Z',
  firstName: 'Alice',
  lastName: 'Martin',
};

const standing = (over: Partial<RefundStanding> = {}): RefundStanding => ({
  purchaseRecordId: 'rec-1',
  refundable: true,
  reason: null,
  withdrawal: 'membership',
  paidCents: 3000,
  refundedCents: 0,
  openRefund: null,
  ...over,
});

const mounted: (() => void)[] = [];
afterEach(() => {
  mounted.splice(0).forEach((f) => f());
  document.body.innerHTML = '';
  state.refund.mockReset();
});

function render(s: RefundStanding = standing()) {
  const onSettled = vi.fn();
  const onClose = vi.fn();
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(RefundDialog, {
    target,
    props: {
      associationId: 'asso-1',
      purchase,
      standing: s,
      buyer: 'Alice Martin',
      item: 'Cotisation',
      onClose,
      onSettled,
    },
  });
  mounted.push(() => unmount(component));
  flushSync();
  return { onSettled, onClose };
}

const dialog = () => document.querySelector<HTMLElement>('[data-testid="refund-dialog"]')!;
const q = <T extends Element>(sel: string) => document.querySelector<T>(sel);

function type(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

function choosePartial() {
  q<HTMLInputElement>('input[value="partial"]')!.click();
  flushSync();
}

async function confirmAndSend() {
  q<HTMLButtonElement>('[data-testid="refund-continue"]')!.click();
  flushSync();
  q<HTMLButtonElement>('[data-testid="refund-send"]')!.click();
  await flushMacrotask();
  flushSync();
}

describe('RefundDialog', () => {
  it('asks a reason before it lets the refund go on', () => {
    render();
    const next = q<HTMLButtonElement>('[data-testid="refund-continue"]')!;
    expect(next.disabled).toBe(true);
    type(q<HTMLInputElement>('#refund-reason')!, 'Event cancelled');
    expect(next.disabled).toBe(false);
  });

  it('a total refund names what it withdraws before it is sent, then refunds the whole amount', async () => {
    state.refund.mockResolvedValue({ state: 'refunded', refusal: null });
    const { onSettled } = render();
    type(q<HTMLInputElement>('#refund-reason')!, 'Event cancelled');
    q<HTMLButtonElement>('[data-testid="refund-continue"]')!.click();
    flushSync();
    expect(dialog().dataset.step).toBe('confirm');
    expect(q('[data-testid="refund-effect"]')!.textContent).toContain(
      m.asso_refund_effect_membership({ buyer: 'Alice Martin' })
    );
    q<HTMLButtonElement>('[data-testid="refund-send"]')!.click();
    await flushMacrotask();
    flushSync();
    const [, , body] = state.refund.mock.calls[0];
    expect(body).toMatchObject({ kind: 'total', reason: 'Event cancelled' });
    expect(body).not.toHaveProperty('amountCents');
    expect(body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(q('[data-testid="refund-outcome"]')!.textContent).toContain(m.asso_refund_done());
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('a partial refund is checked against what is left, sends cents, and withdraws nothing', async () => {
    state.refund.mockResolvedValue({ state: 'refunded', refusal: null });
    render(standing({ refundedCents: 1000 }));
    // Something was refunded already: only a partial refund is offered.
    expect(q('input[value="total"]')).toBeNull();
    const amount = q<HTMLInputElement>('#refund-amount')!;
    type(q<HTMLInputElement>('#refund-reason')!, 'Goodwill');
    type(amount, '25');
    expect(q<HTMLButtonElement>('[data-testid="refund-continue"]')!.disabled).toBe(true);
    type(amount, '12,50');
    q<HTMLButtonElement>('[data-testid="refund-continue"]')!.click();
    flushSync();
    expect(q('[data-testid="refund-effect"]')!.textContent).toContain(
      m.asso_refund_effect_partial({ buyer: 'Alice Martin' })
    );
    q<HTMLButtonElement>('[data-testid="refund-send"]')!.click();
    await flushMacrotask();
    expect(state.refund.mock.calls[0][2]).toMatchObject({ kind: 'partial', amountCents: 1250 });
  });

  it('Lydia not answering reads as a refund to be checked, never as a failure to retry', async () => {
    state.refund.mockRejectedValue(new SocialApiError('x', 'LYDIA_REFUND_UNCONFIRMED', 504));
    render();
    type(q<HTMLInputElement>('#refund-reason')!, 'Event cancelled');
    await confirmAndSend();
    const outcome = q<HTMLElement>('[data-testid="refund-outcome"]')!;
    expect(outcome.textContent).toContain(m.asso_refund_unconfirmed());
    expect(outcome.dataset.tone).toBe('wait');
  });

  it.each([
    ['refused', { state: 'refused', refusal: 'LYDIA_REFUND_REJECTED' }, 'error'],
    ['unconfirmed', { state: 'unconfirmed', refusal: null }, 'wait'],
    ['in-progress', { state: 'in-progress', refusal: null }, 'wait'],
    ['unrecorded', { state: 'unrecorded', refusal: null }, 'wait'],
  ] as const)(
    'a 200 whose refund is %s is worded by its state, never as a refund made',
    async (_name, view, tone) => {
      state.refund.mockResolvedValue(view);
      render();
      type(q<HTMLInputElement>('#refund-reason')!, 'Event cancelled');
      await confirmAndSend();
      const outcome = q<HTMLElement>('[data-testid="refund-outcome"]')!;
      expect(outcome.dataset.tone).toBe(tone);
      expect(outcome.textContent).not.toContain(m.asso_refund_done());
      const words = {
        refused: m.asso_refund_refused_by_lydia(),
        unconfirmed: m.asso_refund_unconfirmed(),
        'in-progress': m.asso_refund_in_progress(),
        unrecorded: m.asso_refund_unrecorded(),
      }[view.state];
      expect(outcome.textContent).toContain(words);
    }
  );

  it('a refusal is worded, and the code itself never shows', async () => {
    state.refund.mockRejectedValue(new SocialApiError('x', 'LYDIA_REFUND_EXCEEDS_PAID', 409));
    render();
    type(q<HTMLInputElement>('#refund-reason')!, 'Event cancelled');
    await confirmAndSend();
    const text = q('[data-testid="refund-outcome"]')!.textContent!;
    expect(text).toContain(m.asso_refund_refused_exceeds());
    expect(text).not.toContain('LYDIA_');
  });

  it('no answer at all says the outcome is unknown, and resends nothing by itself', async () => {
    state.refund.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render();
    choosePartial();
    type(q<HTMLInputElement>('#refund-amount')!, '5');
    type(q<HTMLInputElement>('#refund-reason')!, 'Goodwill');
    await confirmAndSend();
    expect(q('[data-testid="refund-outcome"]')!.textContent).toContain(m.asso_refund_failed());
    expect(state.refund).toHaveBeenCalledTimes(1);
  });
});
