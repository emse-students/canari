// @vitest-environment happy-dom
/**
 * A BANNER IS ONE LINE AND ONE HEIGHT (owner, 2026-11-09). happy-dom has no layout, so this pins the
 * classes that carry it: the row never wraps, it takes the height token, the label truncates beside
 * its actions, and the thin variant takes the thin token.
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

function mountBanner(props: Record<string, unknown>) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(Banner, {
    target,
    props: { children: snippet('<span id="label">text</span>'), ...props } as never,
  });
  mounted.push(() => void unmount(app));
  flushSync();
  return target.firstElementChild as HTMLElement;
}

describe('Banner', () => {
  it('never wraps and carries the one height token', () => {
    const row = mountBanner({});
    expect(row.classList.contains('flex-wrap')).toBe(false);
    expect(row.classList.contains('min-h-(--banner-height)')).toBe(true);
  });

  it('keeps the label shrinkable beside its actions', () => {
    const row = mountBanner({ action: snippet('<b>go</b>') });
    const label = row.querySelector('#label')!.parentElement as HTMLElement;
    expect(label.classList.contains('flex-1')).toBe(true);
    expect(label.classList.contains('min-w-0')).toBe(true);
  });

  it('the thin variant takes the thin token', () => {
    expect(mountBanner({ thin: true }).classList.contains('min-h-(--banner-height-thin)')).toBe(
      true
    );
  });
});
