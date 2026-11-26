// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import CommentMedia from './CommentMedia.svelte';

vi.mock('./PostMedia.svelte', async () => ({
  default: (await import('./PostMediaOpenStub.test-helper.svelte')).default,
}));

/** The inline style of the comment's picture box, for `media`. */
function boxStyle(media: Record<string, unknown>): string {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(CommentMedia, { target, props: { media: media as never, authToken: 't' } });
  flushSync();
  const style = target.querySelector('[data-comment-media]')?.getAttribute('style') ?? '';
  unmount(app);
  target.remove();
  return style;
}

describe('CommentMedia', () => {
  it('takes the picture shape when its size is known', () => {
    expect(boxStyle({ type: 'image', mimeType: 'image/gif', width: 480, height: 270 })).toContain(
      'aspect-ratio'
    );
  });

  it('never forces a fallback shape on a picture sent without a size', () => {
    expect(boxStyle({ type: 'image', mimeType: 'image/gif' })).not.toContain('aspect-ratio');
  });
});

describe('CommentMedia viewer title', () => {
  it("hands the media the comment's author and date, so its viewer is titled like the others", () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    const app = mount(CommentMedia, {
      target,
      props: {
        media: { type: 'image', mimeType: 'image/gif', mediaId: 'g1' } as never,
        authToken: 't',
        info: { senderName: 'Ada L', sentAt: '2026-11-01T10:00:00Z' },
      },
    });
    flushSync();
    const stub = target.querySelector<HTMLElement>('[data-post-media-open]')!;
    expect(stub.dataset.infoSender).toBe('Ada L');
    expect(stub.dataset.infoSent).toBe('2026-11-01T10:00:00Z');
    unmount(app);
    target.remove();
  });
});
