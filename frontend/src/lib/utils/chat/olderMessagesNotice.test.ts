import { describe, expect, it, vi } from 'vitest';
import { parseEnvelope } from '$lib/envelope';
import { compareMessageOrder } from '$lib/utils/chat/messageOrder';
import { mergeMessagePage } from '$lib/utils/chat/messageMerge';
import { chat_older_messages_unavailable } from '$lib/paraglide/messages';
import type { ChatMessage } from '$lib/types';
import {
  keepNoticeOnTop,
  olderMessagesNotice,
  olderMessagesNoticeId,
  oldestServerMs,
} from './olderMessagesNotice';

/**
 * The older-messages notice (channel-encryption section 21.7, user decision 2026-10-12): rows under a
 * v1 session this device does not hold are gone for good here, and a salon says so ONCE rather than
 * showing a gap that reads as a bug. Derived from the load's own dropped rows, never from a timer.
 */

const SALON = 'channel_11111111-2222-3333-4444-555555555555';
const T0 = '2026-10-01T00:00:00.001Z';
const T0_MS = Date.parse(T0);

function bubble(id: string, ms: number): ChatMessage {
  return { id, senderId: 'bob', content: 'x', timestamp: new Date(ms), isOwn: false };
}

describe('olderMessagesNotice', () => {
  it('is null when the load dropped no v1 row', () => {
    expect(olderMessagesNotice(SALON, [{ id: 'a', createdAt: T0 }], [])).toBeNull();
  });

  it('is null when every dropped v1 row was SILENT - a reaction or an edit left no gap', () => {
    const rows = [{ id: 'r', createdAt: T0, silent: true }];
    expect(olderMessagesNotice(SALON, rows, ['r'])).toBeNull();
  });

  it('is a translated system notice, timed just before the oldest row so it sorts to the top', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const notice = olderMessagesNotice(SALON, [{ id: 'v1', createdAt: T0 }], ['v1']);

    expect(notice?.isSystem).toBe(true);
    expect(notice?.isOwn).toBe(false);
    expect(parseEnvelope(notice!.content)).toMatchObject({
      kind: 'system',
      text: chat_older_messages_unavailable(),
    });
    const sorted = [bubble('b', T0_MS), bubble('c', T0_MS + 1), notice!].sort(compareMessageOrder);
    expect(sorted[0].id).toBe(olderMessagesNoticeId(SALON));
  });

  it('is ONE notice per salon however many loads show it, because its id is the salon', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const make = () => olderMessagesNotice(SALON, [{ id: 'v1', createdAt: T0 }], ['v1'])!;
    const first = mergeMessagePage([], [make(), bubble('b', T0_MS)]);
    const again = mergeMessagePage(first, [make(), bubble('b', T0_MS)]);

    expect(again.filter((m) => m.id === olderMessagesNoticeId(SALON))).toHaveLength(1);
    expect(olderMessagesNoticeId('channel_other')).not.toBe(olderMessagesNoticeId(SALON));
  });
});

describe('keepNoticeOnTop', () => {
  const notice = (ms: number): ChatMessage => ({
    ...bubble(olderMessagesNoticeId(SALON), ms),
    isSystem: true,
  });

  it('moves a notice left mid-history back above the oldest message', () => {
    const merged = [bubble('old', 100), notice(500), bubble('new', 900)];

    const kept = keepNoticeOnTop(merged, SALON);

    expect(kept.map((m) => m.id)).toEqual([olderMessagesNoticeId(SALON), 'old', 'new']);
    expect((kept[0].timestamp as Date).getTime()).toBe(99);
  });

  it('returns the SAME array when the notice is already first, or absent', () => {
    const top = [notice(99), bubble('old', 100)];
    const none = [bubble('old', 100)];

    expect(keepNoticeOnTop(top, SALON)).toBe(top);
    expect(keepNoticeOnTop(none, SALON)).toBe(none);
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
