// @vitest-environment happy-dom
/**
 * A BANNER WITH ACTIONS MUST LET THEM WRAP BELOW THE LABEL. On a 392 px phone (Mi 9T) the three
 * device-notice actions sat beside the text and squeezed it into a ~170 px column twelve lines tall.
 * happy-dom has no layout, so this pins the classes that carry the behaviour: the row wraps and the
 * label grows from a readable basis instead of shrinking to whatever the actions leave.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRawSnippet, flushSync, mount, unmount } from 'svelte';
import Banner from './Banner.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

const snippet = (html: string) => createRawSnippet(() => ({ render: () => html }));

describe('Banner', () => {
  it('wraps its actions below a label that keeps a basis and grows', () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    const app = mount(Banner, {
      target,
      props: { children: snippet('<span id="label">text</span>'), action: snippet('<b>go</b>') },
    });
    mounted.push(() => void unmount(app));
    flushSync();
    const row = target.firstElementChild as HTMLElement;
    expect(row.classList.contains('flex-wrap')).toBe(true);
    const label = row.querySelector('#label')!.parentElement as HTMLElement;
    expect(label.classList.contains('flex-1')).toBe(true);
    expect(label.classList.contains('basis-56')).toBe(true);
  });
});
