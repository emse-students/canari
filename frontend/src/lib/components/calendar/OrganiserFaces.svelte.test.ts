/**
 * THE STACK OF ORGANISERS SHOWS THREE FACES AND COUNTS THE REST, AND NAMES EVERYONE TO A READER.
 *
 * Up to four associations run one event (D39, 2026-10-10). The agenda rows used to draw only the
 * organiser's logo, so the stack is the thing that makes a co-organisation visible at all: what
 * matters is the number of discs, the `+N` of the remainder, and the full list in the aria-label
 * that the truncated label beside it cannot carry.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { setLocale } from '$lib/paraglide/runtime';
import type { EventOwnerIdentity } from '$lib/calendar/feedEvents';
import OrganiserFaces from './OrganiserFaces.svelte';

const mounted: ReturnType<typeof mount>[] = [];

function owners(count: number): EventOwnerIdentity[] {
  return Array.from({ length: count }, (_, i) => ({
    associationId: `a${i}`,
    name: `Asso ${i}`,
    slug: `asso-${i}`,
    color: null,
    logoUrl: null,
  }));
}

function render(count: number) {
  mounted.push(mount(OrganiserFaces, { target: document.body, props: { owners: owners(count) } }));
  flushSync();
  const root = document.querySelector('[role="img"]') as HTMLElement;
  return {
    root,
    faces: root.querySelectorAll('.ring-2:not([data-organiser-more])').length,
    more: root.querySelector('[data-organiser-more]') as HTMLElement | null,
  };
}

beforeEach(() => {
  setLocale('en', { reload: false });
});

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
});

describe('OrganiserFaces', () => {
  it.each([[1], [2], [3]])('draws one face per association up to three (%i)', (count) => {
    const { faces, more } = render(count);

    expect(faces).toBe(count);
    expect(more).toBeNull();
  });

  it('draws three faces and a +1 pill for the four associations a full event holds', () => {
    const { faces, more } = render(4);

    expect(faces).toBe(3);
    expect(more?.textContent?.trim()).toBe('+1');
  });

  it('counts a longer legacy list rather than drawing it', () => {
    const { faces, more } = render(6);

    expect(faces).toBe(3);
    expect(more?.textContent?.trim()).toBe('+3');
  });

  it('carries EVERY name in its aria-label and title, whatever is drawn', () => {
    const { root } = render(4);

    expect(root.getAttribute('aria-label')).toBe('Asso 0, Asso 1, Asso 2, Asso 3');
    expect(root.getAttribute('title')).toBe('Asso 0, Asso 1, Asso 2, Asso 3');
  });
});
