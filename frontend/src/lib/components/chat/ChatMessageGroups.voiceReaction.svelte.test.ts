// @vitest-environment happy-dom
/**
 * A REACTION LANDING ON A VOICE NOTE MUST LEAVE ITS PLAYER ALONE, at the level where it actually
 * happens: the thread. `handleAddReaction` writes the reaction into `ReactionsByConversation` AND
 * replaces the message object (`{ ...msg, reactions }`) in a new conversation, so the keyed `{#each}`
 * of `ChatMessageGroups` sees a new group, a new message and a new reactions array under the SAME
 * key. The row must be updated in place: same `<audio>` element, same position.
 */
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { writable } from 'svelte/store';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$app/paths', () => ({ resolve: (route: string) => route }));
vi.mock('$lib/mobile/glassChrome', () => ({ usesGlassChrome: () => true }));
vi.mock('$lib/stores/presenceStore', () => ({
  presenceMap: writable({}),
  watchUsers: () => {},
  unwatchUsers: () => {},
}));
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  getGlobalChat: () => null,
}));
vi.mock('$lib/utils/users/displayName', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/users/displayName')>()),
  getUserDisplayNameSync: (_id: string, fallback?: string) => fallback ?? 'Someone',
  getUserFirstNameSync: (_id: string, fallback: string) => fallback,
  resolveUserDisplayName: async () => null,
}));
vi.mock('$lib/utils/userAvatarCache', () => ({
  resolveUserAvatarDisplay: async () => ({ kind: 'none' as const }),
  releaseUserAvatarDisplay: () => {},
}));
vi.mock('$lib/media', async (orig) => ({
  ...(await orig<typeof import('$lib/media')>()),
  MediaService: class {
    downloadAndDecrypt(ref: { mediaId: string }) {
      return Promise.resolve(`blob:test/${ref.mediaId}`);
    }
  },
}));

import ChatMessageGroups from './ChatMessageGroups.svelte';
import { ReactionsByConversation } from '$lib/utils/chat/reactionsByConversation';
import { serializeEnvelope, mkMediaEnvelope } from '$lib/envelope';
import type { ChatMessage } from '$lib/types';
import type { MediaRef } from '$lib/media';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

afterAll(adoptTransitionAnimations());

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
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

const DM = '11111111-2222-3333-4444-555555555555';
const voice: MediaRef = {
  type: 'audio',
  mediaId: 'voice-1',
  key: '00'.repeat(32),
  iv: '00'.repeat(12),
  mimeType: 'audio/webm',
  fileName: 'vocal.webm',
  size: 1,
  voiceNote: true,
};
const messageOf = (extra: Partial<ChatMessage> = {}) =>
  ({
    id: 'm1',
    senderId: 'alice',
    content: serializeEnvelope(mkMediaEnvelope(voice)),
    timestamp: new Date('2026-11-01T10:00:00Z'),
    isOwn: false,
    isSystem: false,
    ...extra,
  }) as ChatMessage;

it('keeps the same audio element and position through a reaction on the note', async () => {
  const reactions = new ReactionsByConversation();
  const state = $state({ groups: [{ type: 'message' as const, message: messageOf() }] });
  const target = document.body.appendChild(document.createElement('div'));
  const app = mount(ChatMessageGroups, {
    target,
    props: {
      get visibleMessageGroups() {
        return state.groups;
      },
      messageReactions: reactions.of(DM),
      switchTime: 0,
      authToken: 't',
      currentUserId: 'me',
      conversationId: DM,
      isMobile: true,
    } as never,
  });
  mounted.push(() => void unmount(app));
  await vi.waitFor(() => expect(target.querySelector('audio')).not.toBeNull());
  const audio = target.querySelector('audio')!;
  audio.currentTime = 5;

  // What `handleAddReaction` does: the reaction map AND a replaced message object.
  const updated = [{ emoji: '👍', userId: 'me', at: 1 }];
  reactions.set(DM, 'm1', updated);
  state.groups = [{ type: 'message', message: messageOf({ reactions: updated }) }];
  flushSync();
  await Promise.resolve();

  expect(target.querySelector('audio')).toBe(audio);
  expect(audio.currentTime).toBe(5);
});
