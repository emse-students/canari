import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IStorage } from '$lib/db/types';

/**
 * A LIVE unsigned row under a session this device does not hold (channel-encryption section 21.7).
 *
 * Since `minClientVersion` reached the v2 writer every admitted client signs what it sends, so a
 * FRESH unsigned row is a modified client minting v1 or a server stripping a signature: the live path
 * says it at ERROR. The same row read from a history page is an honest pre-floor row and stays a
 * warn (`channelCrypto.test.ts`). Neither asks a peer for the v1 seed this device would refuse.
 *
 * The real `openChannelMessage` and `reportUnreadableChannelMessage` run here, so the class is the
 * one the seal throws and the level is the one the reporter picks - nothing is stubbed between them.
 */

vi.mock('$lib/utils/apiFetch', () => ({ apiFetch: vi.fn() }));
vi.mock('$lib/stores/typingStore.svelte', () => ({ setTyping: vi.fn() }));
vi.mock('$lib/stores/pinStore.svelte', () => ({ applyPin: vi.fn() }));
vi.mock('$lib/stores/pollStore.svelte', () => ({ setPollMeta: vi.fn() }));
vi.mock('$lib/stores/reactionStore.svelte', () => ({ applyChannelReactionFrame: vi.fn() }));

const noteMissingSeed = vi.fn();
vi.mock('$lib/utils/graine/repair', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/graine/repair')>();
  return { ...actual, noteMissingSeed };
});

const { handleChannelEvent } = await import('./channelEventHandler');
const { setGraineRuntime } = await import('$lib/utils/graine/runtime');

const CHANNEL = '11111111-2222-3333-4444-555555555555';

function ctx() {
  const addMessageToChat = vi.fn().mockResolvedValue(undefined);
  return {
    addMessageToChat,
    context: {
      conversations: new Map([[`channel_${CHANNEL}`, { messages: [] }]]),
      addMessageToChat,
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
    userId: 'alice',
    mlsService: {} as never,
  });
}

function created(signature: string | null) {
  return {
    type: 'channel.message.created',
    data: {
      id: 'row-1',
      channelId: CHANNEL,
      senderId: 'mallory',
      ciphertext: 'Y2lwaGVy',
      nonce: 'bm9uY2U=',
      senderSessionId: 'sess-unheld',
      messageIndex: 0,
      signature,
      createdAt: '2026-10-11T12:00:00.000Z',
    },
  };
}

afterEach(() => {
  setGraineRuntime(null);
  vi.restoreAllMocks();
  noteMissingSeed.mockClear();
});

describe('a live channel row under a session not held', () => {
  it('UNSIGNED: refused at ERROR as a v1 session, rendered nowhere, and asks nobody', async () => {
    wireNoSeeds();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { context, addMessageToChat } = ctx();

    await handleChannelEvent(created(null), context);

    expect(addMessageToChat).not.toHaveBeenCalled();
    expect(noteMissingSeed).not.toHaveBeenCalled();
    const accused = error.mock.calls.map((c) => String(c[0]));
    expect(accused.some((l) => l.includes('REFUSED') && l.includes('v1 session sess-unheld'))).toBe(
      true
    );
    expect(warn.mock.calls.some((c) => String(c[0]).includes('sess-unheld'))).toBe(false);
  });

  it('SIGNED (the control): a missing v2 seed is a warn that asks for it', async () => {
    wireNoSeeds();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { context } = ctx();

    await handleChannelEvent(created('c2ln'), context);

    expect(noteMissingSeed).toHaveBeenCalledTimes(1);
    expect(noteMissingSeed.mock.calls[0][1]).toBe('sess-unheld');
    expect(error.mock.calls.some((c) => String(c[0]).includes('sess-unheld'))).toBe(false);
  });
});
