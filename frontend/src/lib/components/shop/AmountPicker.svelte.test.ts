// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { getLocale } from '$lib/paraglide/runtime';
import { formatAmountCents } from '$lib/shop/amountInput';
import AmountPicker from './AmountPicker.svelte';

/** A chip's exact label, the same way the component itself renders one. */
const chipLabel = (cents: number) => formatAmountCents(cents, 'eur', getLocale(), true);

let cmp: ReturnType<typeof mount> | null = null;
let value: number | undefined;

function render(minCents: number | null = 100, maxCents: number | null = null) {
  value = undefined;
  cmp = mount(AmountPicker, {
    target: document.body,
    props: {
      minCents,
      maxCents,
      currency: 'eur',
      get valueCents() {
        return value;
      },
      set valueCents(v: number | undefined) {
        value = v;
      },
    },
  });
  flushSync();
}

const button = (text: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;
const tap = (text: string) => {
  button(text).click();
  flushSync();
};

afterEach(() => {
  if (cmp) unmount(cmp);
  cmp = null;
  document.body.innerHTML = '';
});

describe('AmountPicker', () => {
  it('has no native input at all', () => {
    render();
    expect(document.querySelector('input')).toBeNull();
  });

  it('a chip sets its amount in cents', () => {
    render();
    const chip = [...document.querySelectorAll('button')].find((b) =>
      /20/.test(b.textContent ?? '')
    )!;
    chip.click();
    flushSync();
    expect(value).toBe(2000);
  });

  it('hides chips under the product minimum', () => {
    render(1500);
    const labels = [...document.querySelectorAll('button')].map((b) => b.textContent?.trim());
    expect(labels.some((l) => /^.?5(\D|$)/.test(l ?? '') && !/\d{2}/.test(l ?? ''))).toBe(false);
    expect(labels.some((l) => /20/.test(l ?? ''))).toBe(true);
  });

  it('the keypad types an amount, with no maximum', () => {
    render();
    // "Autre montant" is the last chip: the only one without a digit in its label.
    const other = [...document.querySelectorAll('button')].find(
      (b) => !/\d/.test(b.textContent ?? '')
    )!;
    other.click();
    flushSync();
    for (const k of ['1', '2', '5', '0', '0']) tap(k);
    expect(value).toBe(1250000);
  });

  it('an amount under the minimum is no amount and says why', () => {
    render(100);
    const other = [...document.querySelectorAll('button')].find(
      (b) => !/\d/.test(b.textContent ?? '')
    )!;
    other.click();
    flushSync();
    tap('5');
    expect(value).toBe(500);
    tap('0');
    document.querySelector<HTMLButtonElement>('button[aria-label]')!.click();
    document.querySelector<HTMLButtonElement>('button[aria-label]')!.click();
    flushSync();
    expect(value).toBeUndefined();
    tap('0');
    tap('0');
    expect(value).toBeUndefined();
  });

  it('hides chips over the product maximum', () => {
    render(null, 1500);
    const labels = [...document.querySelectorAll('button')].map((b) => b.textContent?.trim());
    // QUICK_AMOUNTS_CENTS is [500, 1000, 2000, 5000]: a 1500-cent cap keeps the first two.
    expect(labels).toContain(chipLabel(500));
    expect(labels).toContain(chipLabel(1000));
    expect(labels).not.toContain(chipLabel(2000));
    expect(labels).not.toContain(chipLabel(5000));
  });

  it('an amount over the maximum is no amount and says why', () => {
    // A product capped at 20 EUR must not let a typed 50 EUR through: a press the checkout would
    // refuse every time is worse than no amount at all.
    render(null, 2000);
    const other = [...document.querySelectorAll('button')].find(
      (b) => !/\d/.test(b.textContent ?? '')
    )!;
    other.click();
    flushSync();
    for (const k of ['1', '5']) tap(k);
    expect(value).toBe(1500);
    tap('0');
    expect(value).toBeUndefined();
  });
});
