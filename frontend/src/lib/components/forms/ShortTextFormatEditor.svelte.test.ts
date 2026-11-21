// @vitest-environment happy-dom
/** THE FORMAT OF A SHORT TEXT QUESTION, as the card edits it: the bounds appear for a number only. */
import { afterEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ShortTextFormatEditor from './ShortTextFormatEditor.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function render(item: Record<string, any>) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(ShortTextFormatEditor, { target, props: { item } });
  mounted.push(() => unmount(component));
  flushSync();
  return target;
}

describe('ShortTextFormatEditor', () => {
  it('draws no bound for free text, a phone or an e-mail', () => {
    for (const format of [undefined, 'phone', 'email']) {
      const target = render({ id: 'q', format });
      expect(target.querySelector('[data-testid="format-min"]')).toBeNull();
    }
  });

  it('draws the bounds and the decimals switch for a number, and writes them on the question', () => {
    const item = $state({ id: 'q', format: 'number' }) as any;
    const target = render(item);
    const min = target.querySelector<HTMLInputElement>('[data-testid="format-min"]')!;
    min.value = '16';
    min.dispatchEvent(new Event('input'));
    flushSync();
    expect(Number(item.min)).toBe(16);
    const decimals = target.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    decimals.click();
    flushSync();
    expect(item.allowDecimals).toBe(true);
  });
});
