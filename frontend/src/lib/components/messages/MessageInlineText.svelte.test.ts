// @vitest-environment happy-dom
/**
 * The own-bubble flag reaches the mention chip through the inline text run: only the bubble knows
 * what it is filled with, so the run forwards it rather than guessing.
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

import MessageInlineText from './MessageInlineText.svelte';
import { seedUserDisplayName } from '$lib/utils/users/displayName';

const ID = 'ab'.repeat(32);

afterEach(() => {
  document.body.innerHTML = '';
});

function chipClass(onOwnBubble: boolean | undefined): string {
  seedUserDisplayName(ID, 'Bob Martin');
  const target = document.body.appendChild(document.createElement('div'));
  const run = mount(MessageInlineText, { target, props: { text: `hi @[${ID}] ok`, onOwnBubble } });
  flushSync();
  const cls = target.querySelector('button')!.className;
  unmount(run);
  return cls;
}

describe('MessageInlineText forwards the bubble variant to its mentions', () => {
  it('own bubble: the chip has no accent text', () => {
    expect(chipClass(true)).not.toContain('text-accent-text');
  });
  it('default (incoming): the chip keeps the accent text', () => {
    expect(chipClass(undefined)).toContain('text-accent-text');
  });
});

describe('MessageInlineText draws a picked @tous as a call only where it is honoured', () => {
  const draw = (everyoneHonoured: boolean | undefined) => {
    const target = document.body.appendChild(document.createElement('div'));
    const run = mount(MessageInlineText, {
      target,
      props: { text: 'a @[everyone] b', everyoneHonoured },
    });
    flushSync();
    const chip = target.querySelector('[data-mention-everyone]');
    const text = target.textContent;
    unmount(run);
    return { chip, text };
  };

  it('honoured (a private conversation, or a salon row the server vouched for): the chip', () => {
    expect(draw(true).chip).not.toBeNull();
    expect(draw(undefined).chip).not.toBeNull();
  });
  it('unvouched: no chip - nobody was called - but the typed word stays readable', () => {
    const { chip, text } = draw(false);
    expect(chip).toBeNull();
    expect(text).toMatch(/^a @\S+ b$/);
  });
});
