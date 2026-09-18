/**
 * THE HINT PICKS ITS FEE SCHEDULE BY THE PROVIDER ACTUALLY ACTIVE, NOT BY WHICH ONE THIS FILE
 * USED TO BE NAMED AFTER.
 *
 * `StripeNetPayoutHint` rendered Stripe's arithmetic unconditionally - correct while
 * `payment_provider` stayed `stripe`, wrong the day WP-LYDIA-1 flips it, with no way for a
 * treasurer to tell (`docs/wiki/backlog.md`, now removed there since this closes it). Renamed to
 * `PayoutFeeHint` and made to ask `GET /api/payments/provider` - so this pins the ACTUAL pick,
 * not just that the two fee modules compute the right numbers in isolation (already pinned by
 * `stripeFees.test.ts` and `lydiaFees.test.ts`).
 */
import { it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const fetchActivePaymentProvider = vi.fn();
vi.mock('$lib/associations/api', () => ({ fetchActivePaymentProvider }));

const { default: PayoutFeeHint } = await import('./PayoutFeeHint.svelte');

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

/** Flushes the `$effect`'s `fetchActivePaymentProvider().then(...)` microtask. */
const flushProvider = () => new Promise((resolve) => setTimeout(resolve, 0));

function mountHint() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const instance = mount(PayoutFeeHint, { target, props: { grossEuros: 10 } });
  mounted.push(() => unmount(instance));
  return target;
}

it("renders Stripe's fee (0,25 € + 1,5 %) while the provider call is still pending", () => {
  fetchActivePaymentProvider.mockReturnValue(new Promise(() => {})); // never resolves
  const target = mountHint();
  flushSync();

  // 10 € gross, Stripe: 0.25 + 0.15 = 0.40 fee, 9.60 net.
  expect(target.textContent).toContain('9,60');
});

it("switches to Lydia's fee (0,10 € + 1 %) once the active provider resolves to lydia", async () => {
  fetchActivePaymentProvider.mockResolvedValue('lydia');
  const target = mountHint();
  flushSync();
  await flushProvider();
  flushSync();

  // 10 € gross, Lydia: 0.10 + 0.10 = 0.20 fee, 9.80 net.
  expect(target.textContent).toContain('9,80');
  expect(target.textContent).not.toContain('9,60');
});

it('defaults to stripe and logs rather than throwing when the provider call fails', async () => {
  fetchActivePaymentProvider.mockRejectedValue(new Error('network'));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const target = mountHint();
  flushSync();
  await flushProvider();
  flushSync();

  expect(target.textContent).toContain('9,60');
  expect(warn).toHaveBeenCalled();
});
