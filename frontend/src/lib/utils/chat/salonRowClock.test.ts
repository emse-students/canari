/**
 * A salon row is drawn on ONE clock, whichever path wrote it - the server's `createdAt`, the clock
 * every read mark of a salon is on.
 *
 * The flicker the user reported (2026-10-12): the "seen by" heads under a salon's last message
 * appeared, then disappeared. The live path (`channel.message.created`) dated a row by its
 * `createdAt`; the history load dated the SAME row by the author's `sentAt`, and `mergeMessagePage`
 * takes the page's copy. When the author's clock runs ahead of the server's, `sentAt > createdAt`,
 * and a reader whose mark is that `createdAt` (the server bounds every mark by the newest row's
 * `createdAt`) stops reaching the row: the head moves up to the previous message, or vanishes when
 * that message is the reader's own. Production logged 207 such marks in a week, on 26 messages
 * (`[CHANNEL_READ] mark past the newest message bounded`, 2026-10-12). No wall clock here: every
 * instant is a constant and the assertions count heads.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatMessage } from '$lib/types';

const openChannelMessage = vi.fn();
vi.mock('$lib/utils/graine/channelSeal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/graine/channelSeal')>();
  return { ...actual, openChannelMessage };
});

const { decodeChannelMessageRow } = await import('./channelCrypto');
const { encodeAppMessage, mkText } = await import('$lib/proto/codec');
const { mergeMessagePage } = await import('./messageMerge');
const { seenByAnchors } = await import('./readState');
const { serializeEnvelope, mkTextEnvelope } = await import('$lib/envelope');

const RAW = '11111111-2222-3333-4444-555555555555';
const ME = 'viewer';
const AUTHOR = 'author';
const READER_A = 'reader-a';
const READER_B = 'reader-b';

// The newest row: created at T on the server, written at T + 451 ms by an author whose clock leads -
// the first gap production logged.
const EARLIER_CREATED = 1_791_796_600_000;
const NEWEST_CREATED = 1_791_796_645_290;
const NEWEST_SENT = 1_791_796_645_741;

/** A row exactly as `channel.message.created` adds it: dated by the server. */
function liveRow(id: string, senderId: string, createdAt: number): ChatMessage {
  return {
    id,
    senderId,
    content: serializeEnvelope(mkTextEnvelope('x')),
    timestamp: new Date(createdAt),
    serverTimestamp: createdAt,
    isOwn: senderId === ME,
    isSystem: false,
  };
}

/** The same row read back by a history load, with the author's `sentAt` in its payload. */
async function loadedRow(id: string, senderId: string, createdAt: number, sentAt: number) {
  openChannelMessage.mockResolvedValueOnce(encodeAppMessage({ ...mkText('x'), sentAt }));
  const decoded = await decodeChannelMessageRow(
    RAW,
    { id, senderId, createdAt: new Date(createdAt).toISOString(), ciphertext: 'Yw==' } as never,
    ME
  );
  if (decoded?.kind !== 'message') throw new Error('expected a message row');
  return decoded.message satisfies ChatMessage;
}

/** How many heads sit under `messageId`. */
function headsUnder(messages: ChatMessage[], messageId: string, marks: Record<string, number>) {
  return seenByAnchors(messages, marks, ME).get(messageId)?.length ?? 0;
}

describe('a salon row keeps the server clock across a history load', () => {
  beforeEach(() => {
    openChannelMessage.mockReset();
  });

  it('dates a loaded row by its createdAt, never by the author sentAt', async () => {
    const row = await loadedRow('m2', AUTHOR, NEWEST_CREATED, NEWEST_SENT);
    expect(row.timestamp.getTime()).toBe(NEWEST_CREATED);
    expect(row.serverTimestamp).toBe(NEWEST_CREATED);
  });

  it('keeps every head under the last message when the reload merges the same rows', async () => {
    // Both readers read the newest row; the server bounded their marks to its createdAt.
    const marks = { [READER_A]: NEWEST_CREATED, [READER_B]: NEWEST_CREATED };
    const live = [liveRow('m1', READER_A, EARLIER_CREATED), liveRow('m2', AUTHOR, NEWEST_CREATED)];
    expect(headsUnder(live, 'm2', marks)).toBe(2);

    const page = [
      await loadedRow('m1', READER_A, EARLIER_CREATED, EARLIER_CREATED + 300),
      await loadedRow('m2', AUTHOR, NEWEST_CREATED, NEWEST_SENT),
    ];
    const afterReload = mergeMessagePage(live, page);
    expect(headsUnder(afterReload, 'm2', marks)).toBe(2);
    // ...and nobody is pushed up onto the earlier row.
    expect(headsUnder(afterReload, 'm1', marks)).toBe(0);
  });
});
