// @vitest-environment happy-dom
/**
 * THE SEARCH FIELD'S ICONS LIVE IN THE FIELD'S OWN BOX. The magnifier and the clear cross are
 * `absolute top-1/2`: they centre on whatever `relative` box holds them. In 1.8.2 that box also held
 * the filter chips, so on the web and on phones the magnifier sat on the chips row, below the input.
 * happy-dom does no layout, so the structural fact that decides the height is asserted: the icons
 * and the input share ONE `relative` box, and no filter chip is inside it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import PostSearchField from './PostSearchField.svelte';

vi.mock('$lib/paraglide/messages', () => ({
  m: { posts_search_placeholder: () => 'Rechercher', common_clear_aria: () => 'Effacer' },
}));

let target: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (component) unmount(component);
  component = null;
  target?.remove();
});

function render(showClear: boolean) {
  target = document.createElement('div');
  document.body.appendChild(target);
  // The chips row of the real page: a SIBLING of the field, never a child of its box.
  target.insertAdjacentHTML('beforeend', '');
  component = mount(PostSearchField, {
    target,
    props: { value: '', showClear, oninput: () => {}, onclear: () => {} },
  });
  const chips = document.createElement('div');
  chips.setAttribute('data-post-search-filters', '');
  target.appendChild(chips);
  flushSync();
  return chips;
}

describe('PostSearchField', () => {
  it('puts the magnifier, the input and the clear button in one relative box with nothing else', () => {
    const chips = render(true);
    const box = target.querySelector('[data-post-search-field]') as HTMLElement;
    const input = box.querySelector('input') as HTMLInputElement;
    const icon = box.querySelector('svg') as SVGElement;
    const clear = box.querySelector('button') as HTMLButtonElement;

    expect(box.classList.contains('relative')).toBe(true);
    expect(icon.parentElement).toBe(box);
    // `Input` wraps its field in a div of its own: still inside THE box, which is what centres the icons.
    expect(box.contains(input)).toBe(true);
    expect(input.closest('[data-post-search-field]')).toBe(box);
    expect(clear.parentElement).toBe(box);
    expect(box.contains(chips)).toBe(false);
    // Every absolutely-placed icon centres on the input's own box.
    expect(icon.getAttribute('class')).toContain('top-1/2');
    expect(clear.className).toContain('top-1/2');
  });

  it('draws no clear button while there is nothing to clear', () => {
    render(false);
    expect(target.querySelector('[data-post-search-field] button')).toBeNull();
  });
});
