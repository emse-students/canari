import { describe, expect, it, vi } from 'vitest';
import { parseEnvelope } from '$lib/envelope';
import { compareMessageOrder } from '$lib/utils/chat/messageOrder';
import { mergeMessagePage } from '$lib/utils/chat/messageMerge';
import { chat_older_messages_unavailable } from '$lib/paraglide/messages';
import type { ChatMessage } from '$lib/types';
import { olderMessagesNotice, olderMessagesNoticeId, oldestServerMs } from './olderMessagesNotice';

/**
 * The older-messages notice (channel-encryption section 21.7, user decision 2026-10-12): rows under a
 * v1 session this device does not hold are gone for good here, and a salon says so ONCE rather than
 * showing a gap that reads as a bug. Derived from the load's own count, never from a timer.
 */

const SALON = 'channel_11111111-2222-3333-4444-555555555555';

function bubble(id: string, ms: number): ChatMessage {
  return { id, senderId: 'bob', content: 'x', timestamp: new Date(ms), isOwn: false };
}

describe('olderMessagesNotice', () => {
  it('is null when the load dropped no v1 row', () => {
    expect(olderMessagesNotice(SALON, 0, 1_000)).toBeNull();
  });

  it('is a translated system notice, timed just before the oldest row so it sorts to the top', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const notice = olderMessagesNotice(SALON, 3, 1_000);

    expect(notice).not.toBeNull();
    expect(notice?.isSystem).toBe(true);
    expect(notice?.isOwn).toBe(false);
    expect(parseEnvelope(notice!.content)).toMatchObject({
      kind: 'system',
      text: chat_older_messages_unavailable(),
    });
    const sorted = [bubble('b', 1_000), bubble('c', 2_000), notice!].sort(compareMessageOrder);
    expect(sorted[0].id).toBe(olderMessagesNoticeId(SALON));
  });

  it('is ONE notice per salon however many loads show it, because its id is the salon', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const first = mergeMessagePage([], [olderMessagesNotice(SALON, 2, 1_000)!, bubble('b', 1_000)]);
    const again = mergeMessagePage(first, [
      olderMessagesNotice(SALON, 2, 1_000)!,
      bubble('b', 1_000),
    ]);

    expect(again.filter((m) => m.id === olderMessagesNoticeId(SALON))).toHaveLength(1);
    expect(olderMessagesNoticeId('channel_other')).not.toBe(olderMessagesNoticeId(SALON));
  });
});

describe('oldestServerMs', () => {
  it('reads the oldest dated row, read or not, and undefined for a page with none', () => {
    expect(
      oldestServerMs([
        { createdAt: '2026-10-11T12:00:00.000Z' },
        { createdAt: '2026-10-10T12:00:00.000Z' },
        { createdAt: null },
      ])
    ).toBe(Date.parse('2026-10-10T12:00:00.000Z'));
    expect(oldestServerMs([])).toBeUndefined();
  });
});
