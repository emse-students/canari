/**
 * AN ATTACHMENT STILL UPLOADING SHOWS THE UPLOAD (2026-10-10, WP-OFF-8).
 *
 * A 13.4 MB PDF sent on a poor connection was a grey bubble with an endless spinner and no figure,
 * while the peer typed "c'est long la". The bubble now says how much has gone, offers a cancel at
 * every moment and a retry as soon as nothing is moving. Pinned for the file row and for the
 * image/video frame, and that the plain spinner is gone.
 */
import { it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import MessageMediaRenderer from './MessageMediaRenderer.svelte';
import type { MediaRef } from '$lib/media';
import type { UploadView } from '$lib/utils/chat/uploadProgress.svelte';
import { m } from '$lib/paraglide/messages';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

const queued = (type: MediaRef['type']): MediaRef => ({
  type,
  mediaId: '',
  key: '',
  iv: '',
  mimeType: type === 'file' ? 'application/pdf' : `${type}/mp4`,
  size: 13_400_000,
  fileName: 'big.pdf',
});

function render(upload: UploadView | null, type: MediaRef['type'] = 'file') {
  const onCancelUpload = vi.fn();
  const onRetryUpload = vi.fn();
  const instance = mount(MessageMediaRenderer, {
    target: document.body,
    props: {
      mediaRef: queued(type),
      blobUrl: null,
      failure: null,
      textContent: '',
      isOwn: true,
      upload,
      onCancelUpload,
      onRetryUpload,
    },
  });
  mounted.push(() => unmount(instance));
  flushSync();
  const button = (label: string) =>
    Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === label
    );
  return { onCancelUpload, onRetryUpload, button };
}

const uploading: UploadView = {
  phase: 'uploading',
  loaded: 5_400_000,
  total: 13_400_000,
  attempt: 1,
};

it('a file row says the percentage and the bytes, and replaces the endless spinner', () => {
  render(uploading);
  expect(document.body.textContent).toContain('40 %');
  expect(document.body.querySelector('.animate-spin')).toBeNull();
  expect(document.body.querySelector('[role="status"]')).not.toBeNull();
});

it('the cancel is there while it moves and reaches the sender, the retry is not yet offered', () => {
  const { button, onCancelUpload } = render(uploading);
  button(m.upload_cancel_label())!.click();
  expect(onCancelUpload).toHaveBeenCalledOnce();
  expect(button(m.upload_retry_label())).toBeUndefined();
});

it.each(['stalled', 'waiting'] as const)('%s offers a retry beside the cancel', (phase) => {
  const { button, onRetryUpload } = render({ ...uploading, phase });
  button(m.upload_retry_label())!.click();
  expect(onRetryUpload).toHaveBeenCalledOnce();
  expect(button(m.upload_cancel_label())).toBeDefined();
});

it('waiting names what it waits for rather than showing a percentage', () => {
  render({ phase: 'waiting', loaded: 0, total: 0, attempt: 2 });
  expect(document.body.textContent).toContain(m.upload_waiting());
  expect(document.body.textContent).not.toContain('%');
});

it.each(['image', 'video'] as const)('a %s frame carries the same figure and buttons', (type) => {
  const { button } = render(uploading, type);
  expect(document.body.textContent).toContain('40 %');
  expect(button(m.upload_cancel_label())).toBeDefined();
});

it('without an upload the plain spinner is unchanged (a received or settled file)', () => {
  render(null);
  expect(document.body.querySelector('.animate-spin')).not.toBeNull();
});

it.each(['file', 'image'] as const)(
  'a refused %s says so and offers the delete, with no spinner',
  (type) => {
    const onCancelUpload = vi.fn();
    const instance = mount(MessageMediaRenderer, {
      target: document.body,
      props: {
        mediaRef: queued(type),
        blobUrl: null,
        failure: null,
        textContent: '',
        isOwn: true,
        uploadFailed: true,
        onCancelUpload,
      },
    });
    mounted.push(() => unmount(instance));
    flushSync();
    expect(document.body.textContent).toContain(m.upload_failed_label());
    expect(document.body.querySelector('.animate-spin')).toBeNull();
    expect(document.body.querySelector('.animate-pulse')).toBeNull();
    const del = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === m.upload_delete_label()
    );
    del!.click();
    expect(onCancelUpload).toHaveBeenCalledOnce();
  }
);
