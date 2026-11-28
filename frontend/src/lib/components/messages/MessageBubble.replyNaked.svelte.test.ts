// @vitest-environment happy-dom
/**
 * A REPLY NEVER CHANGES HOW ITS OWN MESSAGE IS FRAMED (owner, 2026-11-27): a lone emoji, a link, a
 * GIF and every attachment kind render identically with and without `replyTo`; a plain text reply
 * keeps its bubble.
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

vi.mock('$lib/utils/previewTicket.svelte', () => ({
  ensurePreviewTicket: () => Promise.resolve(),
  previewTicket: () => '',
  gifMediaTicket: () => '',
}));

import MessageBubble from './MessageBubble.svelte';
import { serializeEnvelope, mkMediaEnvelope, mkTextEnvelope } from '$lib/envelope';
import type { MediaRef } from '$lib/media';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()?.();
  document.body.innerHTML = '';
});

const base: MediaRef = {
  type: 'image',
  mediaId: '',
  key: '',
  iv: '',
  mimeType: 'image/jpeg',
  size: 0,
  width: 400,
  height: 300,
};

const quote = { id: 'q1', senderId: 'u-other', content: 'Hello' };

function drawContent(content: string, replyTo?: typeof quote) {
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
      content,
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

const text = (t: string) => serializeEnvelope(mkTextEnvelope(t));
const media = (type: MediaRef['type'], mimeType: string) =>
  serializeEnvelope(mkMediaEnvelope({ ...base, type, mimeType }));

const naked: [string, string][] = [
  ['a lone emoji', text('\u{1F44D}')],
  ['a link', text('https://example.org/page')],
  ['a GIF', text('https://media.giphy.com/media/abc/giphy.gif')],
  ['a photo', media('image', 'image/jpeg')],
  ['a video', media('video', 'video/mp4')],
  ['a voice note', media('audio', 'audio/webm')],
  ['a file', media('file', 'application/pdf')],
];

describe('MessageBubble - a reply keeps its own message render', () => {
  it.each(naked)('%s is drawn the same with and without a reply', (_name, content) => {
    const plain = drawContent(content);
    const reply = drawContent(content, quote);
    expect(reply.cls).toBe(plain.cls);
    expect(reply.cls).not.toContain('bg-bubble-out');
    expect(reply.quoted).toBe(true);
  });

  it('a plain text reply keeps its bubble', () => {
    const reply = drawContent(text('merci beaucoup'), quote);
    expect(reply.cls).toContain('bg-bubble-out');
    expect(reply.quoted).toBe(true);
  });
});
