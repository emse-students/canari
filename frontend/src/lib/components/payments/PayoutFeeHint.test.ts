/**
 * THE HINT SHOWS THE LYDIA SCHEDULE, AND ONLY ONCE THE ACTIVE PROVIDER IS KNOWN TO BE LYDIA.
 *
 * It asks `GET /api/payments/provider` rather than assume the schedule, so this pins the ACTUAL
 * behaviour - nothing while the call is pending or has failed, the Lydia figure on `lydia`, nothing
 * on `disabled` - not just that the fee module computes the right numbers in isolation (pinned by
 * `lydiaFees.test.ts`).
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

it('renders no estimate while the provider call is still pending', () => {
  fetchActivePaymentProvider.mockReturnValue(new Promise(() => {})); // never resolves
  const target = mountHint();
  flushSync();

  expect(target.querySelector('[role="note"]')).toBeNull();
});

it("renders Lydia's fee (0,10 € + 1 %) once the active provider resolves to lydia", async () => {
  fetchActivePaymentProvider.mockResolvedValue('lydia');
  const target = mountHint();
  flushSync();
  await flushProvider();
  flushSync();

  // 10 € gross, Lydia: 0.10 + 0.10 = 0.20 fee, 9.80 net.
  expect(target.textContent).toContain('9,80');
});

it('renders nothing and logs rather than throwing when the provider call fails', async () => {
  fetchActivePaymentProvider.mockRejectedValue(new Error('network'));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const target = mountHint();
  flushSync();
  await flushProvider();
  flushSync();

  expect(target.querySelector('[role="note"]')).toBeNull();
  expect(warn).toHaveBeenCalled();
});

it('renders no hint at all once the platform declares payments disabled', async () => {
  fetchActivePaymentProvider.mockResolvedValue('disabled');
  const target = mountHint();
  flushSync();
  await flushProvider();
  flushSync();

  expect(target.querySelector('[role="note"]')).toBeNull();
});
