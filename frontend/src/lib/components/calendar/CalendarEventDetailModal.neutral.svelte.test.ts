// @vitest-environment happy-dom
/**
 * A NEUTRAL "CAMPUS" EVENT'S CHIP DRAWS THE GENERIC MARK, NEVER AN AVATAR'S ORANGE INITIALS.
 *
 * The modal's chip used `AssociationAvatar` with no logo, whose fallback is initials ("CA"); the
 * owner called it ugly (2026-11-13). The chip must hold the mark, the label, and no link.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { AssociationCalendarFeedEvent } from '$lib/associations/api';
import { setLocale } from '$lib/paraglide/runtime';
import CalendarEventDetailModal from './CalendarEventDetailModal.svelte';

const mounted: ReturnType<typeof mount>[] = [];

beforeEach(() => {
  setLocale('en', { reload: false });
});

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
});

describe('CalendarEventDetailModal - neutral chip', () => {
  it('shows the generic mark beside "Campus" and no initials', () => {
    const event = {
      id: 'ev-1',
      associationId: 'assoc-1',
      title: 'Gala',
      description: null,
      startsAt: '2026-05-13T12:00:00.000Z',
      endsAt: null,
      kind: 'event',
      presentation: 'neutral',
      status: 'approved',
      coOwners: [],
      associationName: 'BDE',
      associationSlug: 'bde',
      associationColor: null,
      associationLogoUrl: null,
    } as unknown as AssociationCalendarFeedEvent;
    mounted.push(
      mount(CalendarEventDetailModal, {
        target: document.body,
        props: { open: true, event, onClose: () => {} },
      })
    );
    flushSync();
    const chip = document.querySelector('[data-event-neutral]') as HTMLElement;
    expect(chip).not.toBeNull();
    expect(chip.querySelector('[data-neutral-mark]')).not.toBeNull();
    expect(chip.textContent?.trim()).toBe('Campus');
    expect(chip.querySelector('a')).toBeNull();
  });
});
