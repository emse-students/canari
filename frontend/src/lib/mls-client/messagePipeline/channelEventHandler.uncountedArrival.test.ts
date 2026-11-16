import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IStorage } from '$lib/db/types';

/**
 * A live salon message whose frame cannot be OPENED yet is still an arrival, and its badge is owed.
 *
 * Read on the Mi 9T (1.7.0-alpha.5) and the iPhone (1.6.12-alpha.2): a salon granted, or a
 * community joined, in session showed no badge for the messages sent before its seed landed - the
 * live tally counts a drawn row, the frame was dropped unopened, and the repair that later drew it
 * is a history load, which counts nothing. The handler now hands such a frame to
 * `onSalonArrivalUncounted`, whose answer is the server's count. The real `openChannelMessage`
 * runs here with no seed held, so the throw is the one a granted member meets.
 */

vi.mock('$lib/utils/apiFetch', () => ({ apiFetch: vi.fn() }));
vi.mock('$lib/stores/typingStore.svelte', () => ({ setTyping: vi.fn() }));
vi.mock('$lib/stores/pinStore.svelte', () => ({ applyPin: vi.fn() }));
vi.mock('$lib/stores/pollStore.svelte', () => ({ setPollMeta: vi.fn() }));
vi.mock('$lib/stores/reactionStore.svelte', () => ({ applyChannelReactionFrame: vi.fn() }));
vi.mock('$lib/utils/graine/repair', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/graine/repair')>();
  return { ...actual, noteMissingSeed: vi.fn() };
});

const { handleChannelEvent } = await import('./channelEventHandler');
const { setGraineRuntime } = await import('$lib/utils/graine/runtime');

const CHANNEL = '11111111-2222-3333-4444-555555555555';
const ME = 'alpha';

function ctx() {
  const addMessageToChat = vi.fn().mockResolvedValue(undefined);
  const onSalonArrivalUncounted = vi.fn();
  return {
    addMessageToChat,
    onSalonArrivalUncounted,
    context: {
      conversations: new Map([[`channel_${CHANNEL}`, { messages: [] }]]),
      userId: ME,
      addMessageToChat,
      onSalonArrivalUncounted,
      log: vi.fn(),
      onOutOfSync: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

function wireNoSeeds(): void {
  setGraineRuntime({
    storage: { getGraineSession: async () => null } as unknown as IStorage,
    deviceKey: () => 'device-key',
    userId: ME,
    mlsService: {} as never,
  });
}

function created(over: Record<string, unknown> = {}) {
  return {
    type: 'channel.message.created',
    data: {
      messageId: 'row-1',
      channelId: CHANNEL,
      senderId: 'beta',
      ciphertext: 'Y2lwaGVy',
      nonce: 'bm9uY2U=',
      senderSessionId: 'sess-not-landed',
      messageIndex: 0,
      signature: 'c2ln',
      createdAt: '2026-11-16T12:00:00.000Z',
      silent: false,
      ...over,
    },
  };
}

afterEach(() => {
  setGraineRuntime(null);
  vi.restoreAllMocks();
});

describe('a live salon frame that cannot be opened yet', () => {
  it("another member's message: drawn nowhere, and its badge is asked for", async () => {
    wireNoSeeds();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { context, addMessageToChat, onSalonArrivalUncounted } = ctx();

    await handleChannelEvent(created(), context);

    expect(addMessageToChat).not.toHaveBeenCalled();
    expect(onSalonArrivalUncounted).toHaveBeenCalledTimes(1);
    expect(onSalonArrivalUncounted).toHaveBeenCalledWith({
      channelId: CHANNEL,
      messageId: 'row-1',
    });
  });

  it('a silent row (a reaction, an edit, a notice) owes no badge', async () => {
    wireNoSeeds();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { context, onSalonArrivalUncounted } = ctx();

    await handleChannelEvent(created({ silent: true }), context);

    expect(onSalonArrivalUncounted).not.toHaveBeenCalled();
  });

  it("this account's own message owes no badge", async () => {
    wireNoSeeds();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { context, onSalonArrivalUncounted } = ctx();

    await handleChannelEvent(created({ senderId: 'ALPHA' }), context);

    expect(onSalonArrivalUncounted).not.toHaveBeenCalled();
  });
});
