/**
 * A salon row carries the server's word on its `@tous` through the history decode: the row says
 * `mentionsEveryone`, the decoded message says `everyoneVouched`, and a row that says nothing is not
 * vouched - the bubble then draws the token as plain text (`everyoneMentionOf`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const openChannelMessage = vi.fn();
vi.mock('$lib/utils/graine/channelSeal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/graine/channelSeal')>();
  return { ...actual, openChannelMessage };
});

const { decodeChannelMessageRow } = await import('./channelCrypto');
const { encodeAppMessage, mkText } = await import('$lib/proto/codec');

const RAW = '11111111-2222-3333-4444-555555555555';

async function decode(extra: Record<string, unknown>) {
  openChannelMessage.mockResolvedValueOnce(encodeAppMessage({ ...mkText('hi @[everyone]') }));
  const decoded = await decodeChannelMessageRow(
    RAW,
    {
      id: 'm1',
      senderId: 'author',
      createdAt: new Date(1_791_796_600_000).toISOString(),
      ciphertext: 'Yw==',
      ...extra,
    } as never,
    'viewer'
  );
  if (decoded?.kind !== 'message') throw new Error('expected a message row');
  return decoded.message;
}

describe('a decoded salon row says whether its @tous was vouched', () => {
  beforeEach(() => openChannelMessage.mockReset());

  it('vouched when the row says so', async () => {
    expect((await decode({ mentionsEveryone: true })).everyoneVouched).toBe(true);
  });
  it('not vouched when the row says false or nothing', async () => {
    expect((await decode({ mentionsEveryone: false })).everyoneVouched).toBeUndefined();
    expect((await decode({})).everyoneVouched).toBeUndefined();
  });
});
