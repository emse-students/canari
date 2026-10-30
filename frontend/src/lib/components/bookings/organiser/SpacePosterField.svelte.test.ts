// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import SpacePosterField from './SpacePosterField.svelte';
import { m } from '$lib/paraglide/messages';

vi.mock('$lib/media', () => ({
  MediaService: class {},
  preparePostMedia: vi.fn(),
}));
vi.mock('$lib/stores/auth', () => ({ getToken: vi.fn() }));

/**
 * The poster zone: a keyboard-reachable file input inside a dashed zone, and a drop that goes
 * through the same checks as a click (a refused type is said, nothing is uploaded).
 */
const mounted: Record<string, unknown>[] = [];

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
});

function open() {
  mounted.push(
    mount(SpacePosterField, {
      target: document.body,
      props: { spaceId: null, spaceName: 'Salle', poster: null, onChanged: vi.fn() },
    })
  );
  flushSync();
}

describe('SpacePosterField - the drop zone', () => {
  it('is one zone around the file input, named by its choose sentence', () => {
    open();
    const zone = document.querySelector('[data-poster-zone]') as HTMLElement;
    expect(zone.tagName).toBe('LABEL');
    expect(zone.querySelector('input[type="file"]')).not.toBeNull();
    expect(zone.textContent).toContain(m.bookings_poster_choose());
  });

  it('refuses a dropped file of a type the server does not take', async () => {
    open();
    const zone = document.querySelector('[data-poster-zone]') as HTMLElement;
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', {
      value: { files: [new File(['x'], 'a.pdf', { type: 'application/pdf' })] },
    });
    zone.dispatchEvent(drop);
    await Promise.resolve();
    flushSync();
    expect(document.body.textContent).toContain(m.bookings_poster_type_error());
  });
});
