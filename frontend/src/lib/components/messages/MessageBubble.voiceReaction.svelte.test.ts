// @vitest-environment happy-dom
/**
 * A REACTION MUST NOT RESTART A VOICE NOTE THAT IS PLAYING. A reaction hands the row a new
 * `reactions` array (and often a new message object); the player is the same note and has to keep
 * its `<audio>` element, and so its position, through it.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  getGlobalChat: () => null,
}));

vi.mock('$lib/media', async (orig) => ({
  ...(await orig<typeof import('$lib/media')>()),
  MediaService: class {
    downloadAndDecrypt(ref: { mediaId: string }) {
      return Promise.resolve(`blob:test/${ref.mediaId}`);
    }
  },
}));

import MessageBubble from './MessageBubble.svelte';
import { serializeEnvelope, mkMediaEnvelope } from '$lib/envelope';
import type { MediaRef } from '$lib/media';
import type { MessageReaction } from '$lib/types';

const mounted: (() => void)[] = [];

beforeEach(() => {
  vi.stubGlobal('fetch', () => Promise.reject(new Error('no network in this test')));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(private cb: (entries: { isIntersecting: boolean }[]) => void) {}
      observe() {
        this.cb([{ isIntersecting: true }]);
      }
      disconnect() {}
    }
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  while (mounted.length) mounted.pop()?.();
  document.body.innerHTML = '';
});

const voice = (): MediaRef => ({
  type: 'audio',
  mediaId: 'voice-1',
  key: '00'.repeat(32),
  iv: '00'.repeat(12),
  mimeType: 'audio/webm',
  fileName: 'vocal.webm',
  size: 1,
  voiceNote: true,
});

it('keeps the same audio element, position and playing state when a reaction arrives', async () => {
  const row = $state({
    content: serializeEnvelope(mkMediaEnvelope(voice())),
    reactions: [] as MessageReaction[],
  });
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(MessageBubble, {
    target,
    props: {
      messageId: 'm1',
      senderId: 'u-other',
      currentUserId: 'u-me',
      authToken: 'tok',
      get content() {
        return row.content;
      },
      get reactions() {
        return row.reactions;
      },
      timestamp: new Date('2026-10-12T10:00:00Z'),
      isOwn: false,
    },
  });
  mounted.push(() => void unmount(app));
  await vi.waitFor(() => expect(target.querySelector('audio')).not.toBeNull());
  const audio = target.querySelector('audio')!;
  Object.defineProperty(audio, 'paused', { configurable: true, get: () => false });
  audio.currentTime = 5;
  audio.dispatchEvent(new Event('play'));
  audio.dispatchEvent(new Event('timeupdate'));
  flushSync();

  // What a reaction does: a fresh content string and a fresh reactions array.
  row.content = serializeEnvelope(mkMediaEnvelope(voice()));
  row.reactions = [{ emoji: '👍', userId: 'u-me', timestamp: 1 } as MessageReaction];
  flushSync();
  await Promise.resolve();

  expect(target.querySelector('audio')).toBe(audio);
  expect(audio.currentTime).toBe(5);
});
