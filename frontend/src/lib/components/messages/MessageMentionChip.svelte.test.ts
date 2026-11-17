// @vitest-environment happy-dom
/**
 * A MENTION IS LEGIBLE ON EVERY BUBBLE (owner, 2026-11-17, Android dark mode: in the sender's own
 * accent-filled bubble the name was yellow on yellow, a blank gap). The own bubble takes the
 * bubble's colour; any other keeps the accent text. Neither carries a `bg-accent/N` tint, whose
 * fallback without `color-mix` is the solid accent.
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

function chipClasses(onOwnBubble: boolean): string[] {
  seedUserDisplayName('u-bob', 'Bob Martin');
  const target = document.body.appendChild(document.createElement('div'));
  const chip = mount(MessageMentionChip, { target, props: { userId: 'u-bob', onOwnBubble } });
  flushSync();
  const button = target.querySelector('button');
  expect(button).not.toBeNull();
  expect(button!.textContent).toContain('@');
  const classes = button!.className.split(/\s+/);
  unmount(chip);
  return classes;
}

describe('the mention chip follows the bubble it sits in', () => {
  it('own bubble: no accent text class, so it inherits the bubble colour', () => {
    const classes = chipClasses(true);
    expect(classes).not.toContain('text-accent-text');
    expect(classes).toContain('font-semibold');
  });

  it('incoming bubble: keeps the accent text colour', () => {
    expect(chipClasses(false)).toContain('text-accent-text');
  });

  it.each([true, false])('no accent tint that falls back to solid accent (own=%s)', (own) => {
    expect(chipClasses(own).some((c) => /(^|:)bg-accent/.test(c))).toBe(false);
  });
});
