// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';

/**
 * BOTH READERS OF A SALON NOTICE - the live frame (`handleChannelEvent`) and the history decode
 * (`decodeChannelMessageRow`) - draw an id-shaped `memberAdded` as a notice naming its people, and
 * never as the raw `{"newUsers":[...]}` text the older reader (`appMsgToChannelSystemEnvelope`) drew.
 * The seal, the name lookup and the side stores are stubbed; the decode, the classification and
 * the notice rendering are the real ones.
 */

const opened = vi.hoisted(() => ({ bytes: new Uint8Array() as Uint8Array }));
vi.mock('$lib/utils/graine/channelSeal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/graine/channelSeal')>()),
  openChannelMessage: vi.fn(async () => opened.bytes),
  openChannelMessageProving: vi.fn(async () => ({ bytes: opened.bytes, authorProven: true })),
}));
vi.mock('$lib/utils/users/displayName', () => ({
  resolveDisplayNames: vi.fn(async () => (id: string) => ({ ana: 'Ana', bob: 'Bob' })[id] ?? id),
}));
vi.mock('$lib/stores/typingStore.svelte', () => ({ setTyping: vi.fn() }));
vi.mock('$lib/stores/pinStore.svelte', () => ({ applyPin: vi.fn() }));
vi.mock('$lib/stores/pollStore.svelte', () => ({ setPollMeta: vi.fn() }));
vi.mock('$lib/stores/reactionStore.svelte', () => ({ applyChannelReactionFrame: vi.fn() }));
vi.mock('$lib/mls-client/tabMessageSync', () => ({ publishTabMessageUpdate: vi.fn() }));

const { encodeAppMessage, mkSystem } = await import('$lib/proto/codec');
const { parseEnvelope } = await import('$lib/envelope');
const { decodeChannelMessageRow } = await import('./channelCrypto');
const { handleChannelEvent } = await import('$lib/mls-client/messagePipeline/channelEventHandler');

const CHANNEL = '11111111-2222-3333-4444-555555555555';
const IDS = JSON.stringify({ newUsers: ['bob'] });

function expectNotice(content: string) {
  expect(content).not.toContain('newUsers');
  expect(parseEnvelope(content)).toMatchObject({
    kind: 'system',
    notice: { event: 'memberAdded', actor: 'ana', targets: ['bob'] },
  });
}

describe('an id-shaped salon notice, through each reader', () => {
  it('the history decode draws the notice, attributed to nobody', async () => {
    opened.bytes = encodeAppMessage(mkSystem('memberAdded', IDS));
    const row = { id: 'r1', senderId: 'Ana', createdAt: '2026-11-16T10:00:00.000Z' };
    const decoded = await decodeChannelMessageRow(CHANNEL, row as never, 'me');
    if (decoded?.kind !== 'message') throw new Error('expected a drawn row');
    expect(decoded.message.senderId).toBe('system');
    expectNotice(decoded.message.content);
  });

  it('the live frame draws the notice, attributed to nobody', async () => {
    opened.bytes = encodeAppMessage(mkSystem('memberAdded', IDS));
    const addMessageToChat = vi.fn(async () => {});
    await handleChannelEvent(
      {
        type: 'channel.message.created',
        data: {
          channelId: CHANNEL,
          messageId: 'r1',
          senderId: 'Ana',
          ciphertext: 'x',
          nonce: 'n',
          createdAt: '2026-11-16T10:00:00.000Z',
        },
      },
      {
        conversations: new Map([[`channel_${CHANNEL}`, { messages: [] }]]),
        userId: 'me',
        addMessageToChat,
        log: vi.fn(),
        onOutOfSync: vi.fn(),
      } as never
    );
    expect(addMessageToChat).toHaveBeenCalledTimes(1);
    const [sender, content] = addMessageToChat.mock.calls[0] as unknown as [string, string];
    expect(sender).toBe('system');
    expectNotice(content);
  });
});
