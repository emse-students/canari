// @vitest-environment happy-dom
/**
 * A MENTION IS LEGIBLE IN THE SENDER'S OWN BUBBLE (owner, 2026-11-17, Android dark mode: the name
 * was yellow on the yellow own bubble, a blank gap in the sentence). `text-accent-text` is the
 * accent family drawn on a NEUTRAL surface; the own bubble is filled with the accent, so the chip
 * must take the bubble's own text colour - the rule the hashtag already follows.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$app/paths', () => ({ resolve: (p: string) => p }));
vi.mock('$lib/stores/user', () => ({
  currentUserId: vi.fn(() => 'u-me'),
  getSavedDisplayName: vi.fn(() => null),
  fetchUserProfile: vi.fn(() => new Promise(() => {})),
  isAbsentUserError: () => false,
  isDeletedAccountError: () => false,
  MalformedUserIdError: class MalformedUserIdError extends Error {},
}));

import MessageMentionChip from './MessageMentionChip.svelte';
import { seedUserDisplayName } from '$lib/utils/users/displayName';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the mention chip takes the colour of the bubble it sits in', () => {
  it('uses currentColor, never the accent text token that equals the own bubble fill', () => {
    seedUserDisplayName('u-bob', 'Bob Martin');
    const target = document.body.appendChild(document.createElement('div'));
    const chip = mount(MessageMentionChip, { target, props: { userId: 'u-bob' } });
    flushSync();
    const button = target.querySelector('button');
    expect(button).not.toBeNull();
    const classes = button!.className.split(/\s+/);
    expect(classes).not.toContain('text-accent-text');
    expect(classes).not.toContain('text-accent');
    expect(classes).toContain('font-semibold');
    expect(button!.textContent).toContain('@');
    unmount(chip);
  });
});
