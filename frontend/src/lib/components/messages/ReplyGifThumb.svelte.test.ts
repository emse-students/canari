/**
 * A QUOTED GIF IS A SMALL DIMMED PICTURE, NOT ITS ADDRESS (user, 2026-10-05).
 *
 * Covers the two places a reply names the GIF it answers: the quote above a reply in the thread
 * (`MessageReplyQuote`) and the thumbnail both draw (`ReplyGifThumb`). The composer's strip uses the
 * same thumbnail through the same `gifPreviewUrl`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import MessageReplyQuote from './MessageReplyQuote.svelte';
import ReplyGifThumb from './ReplyGifThumb.svelte';

const GIF = 'https://static.klipy.com/ii/abc/def.gif#cn-size=498x280';
const apps: Record<string, unknown>[] = [];

afterEach(() => {
  while (apps.length) void unmount(apps.pop()!);
  document.body.innerHTML = '';
});

function render(component: unknown, props: object) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  apps.push(mount(component as never, { target, props }) as Record<string, unknown>);
  flushSync();
}

const quoteProps = (content: string) => ({
  replyId: 'm1',
  content,
  isOwn: false,
  replierDisplayName: 'Leon',
});

describe('ReplyGifThumb', () => {
  it('draws the picture small and dimmed, sized from the URL fragment', () => {
    render(ReplyGifThumb, { url: GIF });
    const img = document.querySelector<HTMLImageElement>('[data-testid="reply-gif-thumb"]')!;
    expect(img.getAttribute('src')).toBe(GIF);
    expect([img.getAttribute('width'), img.getAttribute('height')]).toEqual(['498', '280']);
    expect(img.className).toContain('opacity-60');
    expect(img.className).toContain('max-h-20');
    expect(img.getAttribute('alt')).toBe('[GIF]');
  });

  it('becomes its [GIF] label when the picture cannot load', () => {
    render(ReplyGifThumb, { url: GIF });
    document.querySelector('img')!.dispatchEvent(new Event('error'));
    flushSync();
    expect(document.querySelector('img')).toBeNull();
    expect(document.body.textContent).toContain('[GIF]');
  });
});

describe('MessageReplyQuote', () => {
  it('shows a quoted GIF as the picture and never as its address', () => {
    render(MessageReplyQuote, quoteProps(GIF));
    expect(document.querySelector('[data-testid="reply-gif-thumb"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain('static.klipy.com');
  });

  it('still shows quoted text as text', () => {
    render(MessageReplyQuote, quoteProps('a plain sentence'));
    expect(document.querySelector('img')).toBeNull();
    expect(document.body.textContent).toContain('a plain sentence');
  });
});
