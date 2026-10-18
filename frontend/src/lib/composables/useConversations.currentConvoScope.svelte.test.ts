// @vitest-environment happy-dom
/**
 * The open conversation is recomputed when IT changes, never when another conversation does.
 *
 * `currentConvo` used to iterate the SvelteMap, which subscribes to every key: a message landing in
 * any other conversation or salon re-ran it and handed ChatArea a new object, which regrouped the
 * open thread's whole history. Pinned by counting recomputations, never by a clock.
 */
import { flushSync } from 'svelte';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
  appendLog: vi.fn(),
}));

const { useConversations } = await import('./useConversations.svelte');

const OPEN = 'open-thread';
const row = (id: string, messages: unknown[] = []) => ({ id, name: id, messages }) as never;

function openWithNeighbours(neighbours: number) {
  const convs = useConversations();
  convs.conversations.set(OPEN, row(OPEN));
  for (let i = 0; i < neighbours; i += 1) convs.conversations.set(`other-${i}`, row(`other-${i}`));
  convs.selectConversation(OPEN);
  const seen: unknown[] = [];
  const stop = $effect.root(() => {
    $effect(() => {
      seen.push(convs.currentConvo);
    });
  });
  flushSync();
  return { convs, seen, stop };
}

describe('currentConvo', () => {
  it('is not recomputed when ANOTHER conversation receives a message, adds or leaves', () => {
    const { convs, seen, stop } = openWithNeighbours(50);
    const before = seen.length;

    // One flush per write, as frames arrive one drain at a time.
    for (let i = 0; i < 50; i += 1) {
      convs.conversations.set(`other-${i}`, row(`other-${i}`, [{ id: `m-${i}` }]));
      flushSync();
    }
    convs.conversations.set('brand-new', row('brand-new'));
    flushSync();
    convs.conversations.delete('other-0');
    flushSync();

    expect(seen.length).toBe(before);
    stop();
  });

  it('is recomputed when the OPEN conversation changes, with the new messages', () => {
    const { convs, seen, stop } = openWithNeighbours(3);
    const before = seen.length;

    convs.conversations.set(OPEN, row(OPEN, [{ id: 'm-1' }]));
    flushSync();

    expect(seen.length).toBe(before + 1);
    expect((seen.at(-1) as { messages: unknown[] }).messages).toHaveLength(1);
    stop();
  });

  it('becomes null when the open conversation is removed', () => {
    const { convs, seen, stop } = openWithNeighbours(3);

    convs.conversations.delete(OPEN);
    flushSync();
    expect(seen.at(-1)).toBeNull();
    stop();
  });
});
