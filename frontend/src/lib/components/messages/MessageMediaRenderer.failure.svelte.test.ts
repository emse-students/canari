/**
 * A CHAT ATTACHMENT THAT CANNOT BE SHOWN SAYS WHY (2026-10-01).
 *
 * The renderer took two booleans, `loadError` and `mediaPurgedByRetention`, and every branch tested
 * `loadError` first - which a purge left false, so a purged photo or video pulsed as a loading
 * skeleton for ever. One typed cause replaced both. Pinned: a purge says so instead of pulsing; a
 * retryable cause offers "Reessayer", which reaches the bubble's retry; a 404 offers nothing.
 */
import { it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import MessageMediaRenderer from './MessageMediaRenderer.svelte';
import type { MediaRef } from '$lib/media';
import type { MediaFailureCause } from '$lib/utils/mediaErrors';
import { m } from '$lib/paraglide/messages';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

const image: MediaRef = {
  type: 'image',
  mediaId: 'media-1',
  key: '00'.repeat(32),
  iv: '00'.repeat(12),
  mimeType: 'image/jpeg',
  size: 1024,
};

function render(failure: MediaFailureCause, type: MediaRef['type'] = 'image') {
  const onRetry = vi.fn();
  const instance = mount(MessageMediaRenderer, {
    target: document.body,
    props: { mediaRef: { ...image, type }, blobUrl: null, failure, onRetry, textContent: '' },
  });
  mounted.push(() => unmount(instance));
  flushSync();
  const retry = Array.from(document.body.querySelectorAll('button')).find((b) =>
    b.textContent?.includes(m.media_retry_button())
  );
  return { onRetry, retry };
}

it.each(['image', 'video'] as const)('a purged %s says it expired instead of pulsing', (type) => {
  const { retry } = render('expired', type);
  expect(document.body.querySelector('.animate-pulse')).toBeNull();
  expect(document.body.textContent).toContain(
    type === 'image' ? m.msg_media_expired_label() : m.msg_video_expired_label()
  );
  expect(retry).toBeUndefined();
});

it('an unreachable media names the network and retries through the bubble', () => {
  const { retry, onRetry } = render('unreachable');
  expect(document.body.textContent).toContain(m.media_error_unreachable());
  retry!.click();
  expect(onRetry).toHaveBeenCalledOnce();
});

it('a 404 says the media no longer exists, with no retry', () => {
  const { retry } = render('not-found');
  expect(document.body.textContent).toContain(m.media_error_not_found());
  expect(retry).toBeUndefined();
});
