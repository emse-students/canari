/**
 * A salon draws a CanaRun card, and a kind newer than this build, on BOTH of its reading paths:
 * the live frame (`channel.message.created`) and the history page (`decodeChannelMessageRow`).
 * The seal is stubbed to hand back the plaintext; everything after it is the real code.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import protobuf from 'protobufjs/minimal.js';

vi.mock('$lib/utils/apiFetch', () => ({ apiFetch: vi.fn() }));
vi.mock('$lib/stores/typingStore.svelte', () => ({ setTyping: vi.fn() }));
vi.mock('$lib/stores/pinStore.svelte', () => ({ applyPin: vi.fn() }));
vi.mock('$lib/stores/pollStore.svelte', () => ({ setPollMeta: vi.fn() }));
vi.mock('$lib/stores/reactionStore.svelte', () => ({ applyChannelReactionFrame: vi.fn() }));

const openChannelMessage = vi.fn();
vi.mock('$lib/utils/graine/channelSeal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/graine/channelSeal')>();
  return { ...actual, openChannelMessage };
});

const { handleChannelEvent } = await import('./channelEventHandler');
const { decodeChannelMessageRow } = await import('$lib/utils/chat/channelCrypto');
const { encodeAppMessage, mkRun } = await import('$lib/proto/codec');
const { parseEnvelope, mkRunEnvelope } = await import('$lib/envelope');
const { runActivityToProto } = await import('$lib/canarun/activity');
const { sampleRun } = await import('../../../test/canarunFixture');

const CHANNEL = '11111111-2222-3333-4444-555555555555';
const CREATED = '2026-10-27T09:00:00.000Z';

function runBytes(): Uint8Array {
  return encodeAppMessage({ ...mkRun(runActivityToProto(sampleRun())), messageId: 'client-1' });
}

function futureBytes(): Uint8Array {
  const w = protobuf.Writer.create();
  w.uint32((6 << 3) | 2).string('client-2');
  w.uint32((99 << 3) | 2).bytes(new Uint8Array([0x0a, 0x00]));
  return w.finish();
}

async function live(plaintext: Uint8Array) {
  openChannelMessage.mockResolvedValueOnce(plaintext);
  const addMessageToChat = vi.fn().mockResolvedValue(undefined);
  await handleChannelEvent(
    {
      type: 'channel.message.created',
      data: {
        messageId: 'row-1',
        channelId: CHANNEL,
        senderId: 'runner',
        ciphertext: 'Y2lwaGVy',
        nonce: 'bm9uY2U=',
        senderSessionId: 'sess-1',
        messageIndex: 0,
        signature: 'c2ln',
        createdAt: CREATED,
      },
    },
    {
      conversations: new Map([[`channel_${CHANNEL}`, { messages: [] }]]),
      addMessageToChat,
      userId: 'reader',
      log: vi.fn(),
      onOutOfSync: vi.fn(),
    } as never
  );
  return addMessageToChat;
}

async function history(plaintext: Uint8Array) {
  openChannelMessage.mockResolvedValueOnce(plaintext);
  const decoded = await decodeChannelMessageRow(
    CHANNEL,
    { id: 'row-2', senderId: 'runner', createdAt: CREATED, ciphertext: 'Yw==' } as never,
    'reader'
  );
  if (decoded?.kind !== 'message') throw new Error('expected a message row');
  return decoded.message;
}

afterEach(() => {
  openChannelMessage.mockReset();
  vi.restoreAllMocks();
});

describe('a salon and CanaRun', () => {
  it('LIVE: draws the run as the activity card, under the row id', async () => {
    const add = await live(runBytes());
    expect(add).toHaveBeenCalledTimes(1);
    const [sender, content, convo, opts] = add.mock.calls[0];
    expect(sender).toBe('runner');
    expect(convo).toBe(`channel_${CHANNEL}`);
    expect(parseEnvelope(content as string)).toEqual(mkRunEnvelope(sampleRun()));
    expect((opts as { messageId: string }).messageId).toBe('row-1');
  });

  it('HISTORY: draws the same card from a page row', async () => {
    const row = await history(runBytes());
    expect(parseEnvelope(row.content)).toEqual(mkRunEnvelope(sampleRun()));
    expect(row.senderId).toBe('runner');
  });

  it('LIVE and HISTORY: show a newer kind as "needs a newer version"', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const add = await live(futureBytes());
    expect(parseEnvelope(add.mock.calls[0][1] as string)).toEqual({
      kind: 'unsupported',
      reason: 'unknown-kind',
      field: 99,
    });
    const row = await history(futureBytes());
    expect(parseEnvelope(row.content).kind).toBe('unsupported');
  });
});
