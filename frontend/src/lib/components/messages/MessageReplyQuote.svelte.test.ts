/**
 * A QUOTE THAT IS CUT MUST SAY SO (user, 2026-10-05: a reply's quote ended mid-sentence, no "...").
 *
 * The stored preview was `slice(0, 100)` of the RAW text; an `@[uuid]` mention is ~40 raw characters
 * drawn as a short name, so the formatted quote fell under the 84 that adds the ellipsis and the cut
 * went unmarked. `cutReplyPreview` marks the cut where it is made.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import MessageReplyQuote from './MessageReplyQuote.svelte';
import { cutReplyPreview } from '$lib/utils/chat/messageDisplay';

vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: () => 'Jeanne BOUSSONNIERE',
  resolveUserDisplayName: () => Promise.resolve('Jeanne BOUSSONNIERE'),
}));

const ID = '3f9a1c2e11114222833344445555666677778888999900001111222233334444';
const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function quoteText(content: string): string {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(MessageReplyQuote, {
    target,
    props: { content, isOwn: false, replierDisplayName: 'Jeanne' },
  });
  flushSync();
  mounted.push(() => unmount(app, { outro: false }));
  return target.querySelector('button')!.textContent!.trim();
}

describe('cutReplyPreview', () => {
  it('leaves a short text alone', () => {
    expect(cutReplyPreview('salut')).toBe('salut');
  });

  it('marks a cut with an ellipsis', () => {
    const out = cutReplyPreview('a'.repeat(150));
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBe(101);
  });

  it('never leaves half a mention token behind the cut', () => {
    const text = `${'a'.repeat(90)} @[${ID}] et la suite`;
    const out = cutReplyPreview(text);
    expect(out).not.toContain('@[');
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('MessageReplyQuote - a truncated quote ends with an ellipsis', () => {
  it('shows the mention as a name and the ellipsis of a cut that happened after it', () => {
    const stored = cutReplyPreview(`@[${ID}] , ${'pas de news '.repeat(10)}`);
    const text = quoteText(stored);
    expect(text.startsWith('@Jeanne BOUSSONNIERE')).toBe(true);
    expect(text.endsWith('…')).toBe(true);
  });

  it('adds the ellipsis itself when the formatted text is still over the display cap', () => {
    expect(quoteText('b'.repeat(200)).endsWith('…')).toBe(true);
  });
});
