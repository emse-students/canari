/**
 * THE GLASS BUTTON THAT GROWS INTO ITS OPTIONS (user, 2026-09-30) - the conversation header's menu
 * and the composer's "+". What these pin is behaviour, not the glass: it opens on a tap, runs the
 * picked action INSIDE that tap (a file picker only opens from a user gesture), closes on a pick,
 * on Escape and outside, and says which entries are on.
 */
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { Search, Settings, Ellipsis } from '@lucide/svelte';
import GlassMenuButton, { type GlassMenuItem } from './GlassMenuButton.svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

afterAll(adoptTransitionAnimations());

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function mountMenu(items: GlassMenuItem[]) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(GlassMenuButton, { target, props: { icon: Ellipsis, label: 'Plus', items } });
  mounted.push(() => void unmount(app));
  flushSync();
  return document.querySelector<HTMLButtonElement>('button[aria-label="Plus"]')!;
}

describe('GlassMenuButton', () => {
  it('opens on a tap, and runs the picked action within it before closing', () => {
    const onSearch = vi.fn();
    const button = mountMenu([
      { id: 'search', label: 'Rechercher', icon: Search, onSelect: onSearch },
      { id: 'settings', label: 'Paramètres', icon: Settings, onSelect: vi.fn() },
    ]);
    expect(document.querySelector('[role="menu"]')).toBeNull();

    button.click();
    flushSync();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const items = [...document.querySelectorAll('[role="menuitem"]')].map((i) =>
      i.textContent?.trim()
    );
    expect(items).toEqual(['Rechercher', 'Paramètres']);

    (document.querySelector('[role="menuitem"]') as HTMLButtonElement).click();
    flushSync();
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes on Escape without running anything', () => {
    const onSelect = vi.fn();
    const button = mountMenu([{ id: 'a', label: 'A', icon: Search, onSelect }]);
    button.click();
    flushSync();

    document
      .querySelector('[role="menu"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    flushSync();

    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('draws an entry that shows a state as a checkbox, and says whether it is on', () => {
    const button = mountMenu([
      { id: 'search', label: 'Rechercher', icon: Search, onSelect: vi.fn(), active: true },
      { id: 'settings', label: 'Paramètres', icon: Settings, onSelect: vi.fn() },
    ]);
    button.click();
    flushSync();

    const search = document.querySelector('[role="menuitemcheckbox"]');
    expect(search?.getAttribute('aria-checked')).toBe('true');
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(1);
  });
});
