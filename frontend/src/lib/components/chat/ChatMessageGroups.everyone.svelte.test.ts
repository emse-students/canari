// @vitest-environment happy-dom
/**
 * A salon row's `@tous` is honoured by its bubble only when the SERVER vouched for it
 * (`everyoneMentionOf`): the thread hands each bubble the verdict, so an unvouched token is drawn as
 * plain text and a private conversation (which needs no vouching) keeps its chip.
 */
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';
import { writable } from 'svelte/store';

const bubbles = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$app/paths', () => ({ resolve: (route: string) => route }));
vi.mock('$lib/mobile/glassChrome', () => ({ usesGlassChrome: () => true }));
vi.mock('$lib/stores/presenceStore', () => ({
  presenceMap: writable({}),
  watchUsers: () => {},
  unwatchUsers: () => {},
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
vi.mock('../messages/MessageBubble.svelte', () => ({
  default: (_anchor: unknown, props: Record<string, unknown>) => {
    bubbles.props.push(props);
  },
}));

import ChatMessageGroups from './ChatMessageGroups.svelte';
import type { ChatMessage } from '$lib/types';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

afterAll(adoptTransitionAnimations());

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  bubbles.props.length = 0;
});

const SALON = 'channel_7d2f0aa0-0000-4000-8000-000000000001';
const DM = '11111111-2222-3333-4444-555555555555';

async function honoured(conversationId: string, over: Partial<ChatMessage>) {
  const message = {
    id: 'm1',
    senderId: 'alice',
    content: 'x @[everyone]',
    timestamp: new Date('2026-11-01T10:00:00Z'),
    isOwn: false,
    isSystem: false,
    ...over,
  } as ChatMessage;
  const target = document.body.appendChild(document.createElement('div'));
  const app = mount(ChatMessageGroups, {
    target,
    props: {
      visibleMessageGroups: [{ type: 'message' as const, message }],
      switchTime: 0,
      authToken: 't',
      currentUserId: 'me',
      conversationId,
    } as never,
  });
  mounted.push(() => void unmount(app));
  await tick();
  flushSync();
  return bubbles.props.at(-1)?.everyoneHonoured;
}

describe('the thread tells each bubble whether its @tous is a call', () => {
  it('a salon row the server vouched for: honoured', async () => {
    expect(await honoured(SALON, { everyoneVouched: true })).toBe(true);
  });
  it('a salon row the server did not vouch for: not honoured', async () => {
    expect(await honoured(SALON, {})).toBe(false);
  });
  it('a private conversation needs no vouching: honoured', async () => {
    expect(await honoured(DM, {})).toBe(true);
  });
});
