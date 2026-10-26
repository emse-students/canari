// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import AmountPicker from './AmountPicker.svelte';

let cmp: ReturnType<typeof mount> | null = null;
let value: number | undefined;

function render(minCents: number | null = 100) {
  value = undefined;
  cmp = mount(AmountPicker, {
    target: document.body,
    props: {
      minCents,
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
});
