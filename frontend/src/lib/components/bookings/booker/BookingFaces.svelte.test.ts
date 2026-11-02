// @vitest-environment happy-dom
/** THE OTHER PEOPLE OF A BOOKING: nothing when alone, every name in the label, a +N past three faces. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { setLocale } from '$lib/paraglide/runtime';
import BookingFaces from './BookingFaces.svelte';

vi.mock('$lib/components/shared/Avatar.svelte', () => ({ default: () => {} }));

const mounted: ReturnType<typeof mount>[] = [];
const person = (name: string) => ({ id: `u-${name}`, name });

function render(people: { id: string; name: string }[]) {
  mounted.push(mount(BookingFaces, { target: document.body, props: { people } }));
  flushSync();
}

beforeEach(() => setLocale('en', { reload: false }));
afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!, { outro: false });
  document.body.innerHTML = '';
});

describe('BookingFaces', () => {
  it('draws nothing when the viewer is alone', () => {
    render([]);
    expect(document.querySelector('[role="img"]')).toBeNull();
  });

  it('draws two people sharing an id (erased accounts) without a duplicate-key error', () => {
    render([
      { id: '', name: 'A' },
      { id: '', name: 'B' },
    ]);
    expect(document.querySelector('[role="img"]')?.getAttribute('aria-label')).toContain('A, B');
  });

  it('labels the whole stack with every name and counts the faces past three', () => {
    render(['Alice', 'Bob', 'Chloe', 'Dan', 'Eve'].map(person));
    expect(document.querySelector('[role="img"]')?.getAttribute('aria-label')).toContain(
      'Alice, Bob, Chloe, Dan, Eve'
    );
    expect(document.querySelector('[data-booking-more]')?.getAttribute('data-booking-more')).toBe(
      '2'
    );
  });
});
