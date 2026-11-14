// @vitest-environment happy-dom
/**
 * A SALON ECHO RE-KEYED TO THE SERVER'S ID IS THE SAME ROW (review of #3490, B2).
 *
 * `salonEcho` swaps the echo's client UUID for the server's id at delivery. Keyed by `id`, the
 * thread would destroy the row and mount a new one, which replays the bubble's entrance - the bubble
 * vanished and faded in again at delivery. The row keeps `renderKey`, so the same element stays and
 * only its props change (keyboard-and-send-motion.md).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';

vi.mock('../messages/MessageBubble.svelte', () => ({ default: () => {} }));
vi.mock('../messages/SeenByHeads.svelte', () => ({ default: () => {} }));

import ChatMessageGroups from './ChatMessageGroups.svelte';
import type { ChatMessage } from '$lib/types';
import { nextEchoMessages } from '$lib/utils/chat/salonEcho';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

const echo: ChatMessage = {
  id: 'local',
  senderId: 'me',
  content: 'hi',
  timestamp: new Date('2026-11-13T10:00:00Z'),
  isOwn: true,
  isSystem: false,
  status: 'sending',
  awaitingServerId: true,
};

describe('a salon echo settling on its server id', () => {
  it('keeps its row element: the thread updates it and does not remount it', async () => {
    const props = $state({
      visibleMessageGroups: [{ type: 'message' as const, message: echo }],
      switchTime: 0,
      authToken: 't',
      currentUserId: 'me',
    });
    const target = document.createElement('div');
    document.body.appendChild(target);
    const app = mount(ChatMessageGroups, { target, props });
    mounted.push(() => void unmount(app));
    await tick();
    flushSync();
    const list = target.firstElementChild as HTMLElement;
    const before = list.firstElementChild;
    expect(before).not.toBeNull();

    const settled = nextEchoMessages([echo], 'local', { kind: 'settled', serverId: 'srv' })!;
    expect(settled[0].id).toBe('srv');
    props.visibleMessageGroups = [{ type: 'message' as const, message: settled[0] }];
    await tick();
    flushSync();

    expect(list.firstElementChild).toBe(before);
    expect(before?.isConnected).toBe(true);
  });
});
