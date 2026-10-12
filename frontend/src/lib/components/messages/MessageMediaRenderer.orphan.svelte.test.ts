/**
 * A MEDIA ROW NOTHING WILL EVER FILL SAYS SO, AND AN OWN FILE CARD WITH NO BUBBLE BEHIND IT USES
 * THEME TOKENS (Mi 9T, alpha.3). The orphan used to draw the queued spinner for ever; the card's
 * navy ink and `black/10` wash assumed an amber bubble that a media-only message does not have.
 */
import { it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import MessageMediaRenderer from './MessageMediaRenderer.svelte';
import type { MediaRef } from '$lib/media';
import { m } from '$lib/paraglide/messages';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

const ref = (type: MediaRef['type']): MediaRef => ({
  type,
  mediaId: '',
  key: '',
  iv: '',
  mimeType: type === 'file' ? 'application/pdf' : `${type}/mp4`,
  size: 0,
  fileName: 'a.pdf',
});

function render(props: Record<string, unknown>, type: MediaRef['type'] = 'file') {
  const onCancelUpload = vi.fn();
  const instance = mount(MessageMediaRenderer, {
    target: document.body,
    props: {
      mediaRef: ref(type),
      blobUrl: null,
      failure: null,
      textContent: '',
      onCancelUpload,
      ...props,
    },
  });
  flushSync();
  mounted.push(() => unmount(instance));
  return { onCancelUpload };
}

it.each(['file', 'image', 'audio'] as const)(
  'an orphan %s row shows the failure and the delete',
  (type) => {
    const { onCancelUpload } = render({ orphan: true, isOwn: true }, type);
    expect(document.body.textContent).toContain(m.media_orphan_label());
    expect(document.querySelector('.animate-spin')).toBeNull();
    const del = document.querySelector(`[aria-label="${m.upload_delete_label()}"]`) as HTMLElement;
    del.click();
    expect(onCancelUpload).toHaveBeenCalledOnce();
  }
);

it('a queued (non-orphan) row still shows the spinner', () => {
  render({ orphan: false, isOwn: true });
  expect(document.querySelector('.animate-spin')).not.toBeNull();
  expect(document.body.textContent).not.toContain(m.media_orphan_label());
});

it('an own file card with no bubble behind it carries no amber-bubble ink', () => {
  render({ isOwn: true, onBubble: false });
  const card = document.querySelector('.rounded-3xl.border') as HTMLElement;
  expect(card.className).not.toContain('text-cn-ink');
  expect(card.className).toContain('dark:bg-white/10');
});

it('an own file card on the amber bubble keeps its ink', () => {
  render({ isOwn: true, onBubble: true });
  const card = document.querySelector('.rounded-3xl.border') as HTMLElement;
  expect(card.className).toContain('text-cn-ink');
});
