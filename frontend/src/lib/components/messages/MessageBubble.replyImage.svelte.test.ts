// @vitest-environment happy-dom
/**
 * AN OWN PHOTO SENT AS A REPLY HAS NO FRAME (owner, 2026-11-27: the yellow edge around an image in
 * a reply): it is drawn like a photo that answers nothing, and the quote stays stacked above it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  getGlobalChat: () => null,
}));

vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: () => 'Leon',
  getUserFirstNameSync: () => 'Leon',
  peekUserDisplayName: () => 'Leon',
  resolveUserDisplayName: () => Promise.resolve('Leon'),
}));

import MessageBubble from './MessageBubble.svelte';
import { serializeEnvelope, mkMediaEnvelope } from '$lib/envelope';
import type { MediaRef } from '$lib/media';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()?.();
  document.body.innerHTML = '';
});

const photo: MediaRef = {
  type: 'image',
  mediaId: '',
  key: '',
  iv: '',
  mimeType: 'image/jpeg',
  size: 0,
  width: 400,
  height: 300,
};

const quote = { id: 'q1', senderId: 'u-other', content: 'Photo' };

function draw(ref: MediaRef, replyTo?: typeof quote) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(MessageBubble, {
    target,
    props: {
      messageId: 'm1',
      senderId: 'u-me',
      currentUserId: 'u-me',
      authToken: 'tok',
      isOwn: true,
      content: serializeEnvelope(mkMediaEnvelope(ref)),
      timestamp: new Date('2026-10-05T10:00:00Z'),
      replyTo,
    },
  });
  mounted.push(() => void unmount(app));
  flushSync();
  return {
    cls: target.querySelector('[data-message-bubble]')!.className,
    quoted: !!target.querySelector('button[title]'),
  };
}

describe('MessageBubble - an image sent as a reply', () => {
  it('has no coloured padded frame, like a plain image, and keeps its quote', () => {
    const plain = draw(photo);
    const reply = draw(photo, quote);
    expect(reply.cls).toContain('p-0');
    expect(reply.cls).not.toContain('bg-bubble-out');
    expect(reply.cls).not.toContain('px-3');
    expect(plain.cls).toContain('p-0');
    expect(reply.quoted).toBe(true);
  });

  it('keeps a file reply unframed too: a reply never changes the message render', () => {
    const file: MediaRef = { ...photo, type: 'file', mimeType: 'application/pdf' };
    expect(draw(file, quote).cls).toBe(draw(file).cls);
    expect(draw(file, quote).cls).not.toContain('bg-bubble-out');
  });
});
