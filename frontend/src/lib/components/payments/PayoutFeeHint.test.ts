// @vitest-environment happy-dom
/**
 * THE HINT SHOWS THE PLATFORM'S FEE SCHEDULE, AND ONLY ONCE THE ACTIVE PROVIDER IS KNOWN TO BE LYDIA.
 *
 * It asks `GET /api/payments/provider` and `GET /api/payments/lydia-fee-schedule` rather than assume
 * either, so this pins the ACTUAL behaviour - nothing while a call is pending or has failed, the
 * figure the admin-entered schedule gives on `lydia`, "not configured" while none is entered, nothing
 * on `disabled` - not just that the fee module computes the right numbers in isolation (pinned by
 * `lydiaFees.test.ts`). The schedule below is made up for the test.
 */
import { it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { flushMacrotask } from '../../../test/flush';

const fetchActivePaymentProvider = vi.fn();
vi.mock('$lib/associations/api', () => ({ fetchActivePaymentProvider }));
const fetchLydiaFeeSchedule = vi.fn();
vi.mock('$lib/payments/lydiaFees', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/payments/lydiaFees')>()),
  fetchLydiaFeeSchedule,
}));
const SCHEDULE = { percentBps: 300, fixedCents: 20, vatBps: 5_000 };

const { default: PayoutFeeHint } = await import('./PayoutFeeHint.svelte');

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

/** Flushes the `$effect`'s `fetchActivePaymentProvider().then(...)` microtask. */
const flushProvider = () => flushMacrotask();

function mountHint() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const instance = mount(PayoutFeeHint, { target, props: { grossEuros: 10 } });
  mounted.push(() => unmount(instance));
  return target;
}

it('renders no estimate while the provider call is still pending', () => {
  fetchActivePaymentProvider.mockReturnValue(new Promise(() => {})); // never resolves
  fetchLydiaFeeSchedule.mockResolvedValue(SCHEDULE);
  const target = mountHint();
  flushSync();

  expect(target.querySelector('[role="note"]')).toBeNull();
});

it('renders the admin-entered fee, VAT included, once the provider resolves to lydia', async () => {
  fetchActivePaymentProvider.mockResolvedValue('lydia');
  fetchLydiaFeeSchedule.mockResolvedValue(SCHEDULE);
  const target = mountHint();
  flushSync();
  await flushProvider();
  flushSync();

  // 10 EUR gross: HT 0.20 + 0.30 = 0.50, times 1.5 = 0.75 fee, 9.25 net. The price paid, then
  // the net beneath it - never the fee itself, never "approximately" (owner, 2026-11-14).
  const lines = [...target.querySelectorAll('p')].map((p) => p.textContent ?? '');
  const paid = lines.findIndex((l) => l.includes('10,00'));
  const net = lines.findIndex((l) => l.includes('9,25'));
  expect(paid).toBeGreaterThanOrEqual(0);
  expect(net).toBe(paid + 1);
  expect(target.querySelectorAll('p')[net].className).toContain('text-2xs');
  expect(target.textContent).not.toContain('0,75');
  expect(target.textContent).not.toMatch(/environ|approx/i);
});

it('says the estimate is not configured while no schedule is entered - never a default figure', async () => {
  fetchActivePaymentProvider.mockResolvedValue('lydia');
  fetchLydiaFeeSchedule.mockResolvedValue(null);
  const target = mountHint();
  flushSync();
  await flushProvider();
  flushSync();

  expect(target.querySelector('[role="note"]')).not.toBeNull();
  expect(target.textContent).not.toMatch(/\d,\d\d/);
});

it('renders no hint for a reader the schedule is refused to, and logs nothing more', async () => {
  fetchActivePaymentProvider.mockResolvedValue('lydia');
  fetchLydiaFeeSchedule.mockResolvedValue('not-a-price-editor');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const target = mountHint();
  flushSync();
  await flushProvider();
  flushSync();

  expect(target.querySelector('[role="note"]')).toBeNull();
  expect(warn).not.toHaveBeenCalled();
});

it('renders no estimate when the schedule call fails', async () => {
  fetchActivePaymentProvider.mockResolvedValue('lydia');
  fetchLydiaFeeSchedule.mockRejectedValue(new Error('network'));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const target = mountHint();
  flushSync();
  await flushProvider();
  flushSync();

  expect(target.querySelector('[role="note"]')).toBeNull();
  expect(warn).toHaveBeenCalled();
});

it('renders nothing and logs rather than throwing when the provider call fails', async () => {
  fetchActivePaymentProvider.mockRejectedValue(new Error('network'));
  fetchLydiaFeeSchedule.mockResolvedValue(SCHEDULE);
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
  fetchLydiaFeeSchedule.mockResolvedValue(SCHEDULE);
  const target = mountHint();
  flushSync();
  await flushProvider();
  flushSync();

  expect(target.querySelector('[role="note"]')).toBeNull();
});
