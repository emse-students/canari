import { encodeAppMessage, decodeAppMessage, mkText, mkSystem } from '$lib/proto/codec';
import { parseEnvelope } from '$lib/envelope';
import {
  appMessageSentAtMs,
  appMsgToEnvelope,
  appMsgToChannelSystemEnvelope,
  computeMessageListSwitchTime,
  indexMessagesById,
  isStaleInboundMessage,
  normalizeMessageId,
  resolveAppMessageTimestampMs,
  resolveMessageTimestamp,
  STALE_INBOUND_MS,
} from './messageUtils';
import type { ChatMessage } from '$lib/types';

describe('resolveMessageTimestamp', () => {
  const existing: ChatMessage[] = [
    {
      id: 'm1',
      senderId: 'alice',
      content: '{}',
      timestamp: new Date('2024-06-01T10:00:00Z'),
      isOwn: false,
    },
  ];

  /** The lookup the caller supplies, over the fixture above. */
  const byId = indexMessagesById(existing);
  const find = (id: string) => byId.get(id);

  it('prefers explicit timestamp in options', () => {
    const ts = new Date('2024-01-01T00:00:00Z');
    expect(resolveMessageTimestamp({ timestamp: ts }, find, false).getTime()).toBe(ts.getTime());
  });

  it('reuses timestamp from an existing message with the same id', () => {
    const ts = resolveMessageTimestamp({ messageId: 'm1' }, find, false);
    expect(ts.getTime()).toBe(existing[0].timestamp.getTime());
  });

  it('uses fallbackMs when provided', () => {
    const fallback = Date.parse('2023-12-01T12:00:00Z');
    expect(resolveMessageTimestamp({}, find, false, fallback).getTime()).toBe(fallback);
  });

  it('never scans: it asks the lookup exactly once, and only when it needs to', () => {
    // The reason the parameter is a function at all. A caller ingesting a batch supplies an index,
    // and a resolver that scanned instead would put the cost back where the freeze came from.
    const lookup = vi.fn(find);

    resolveMessageTimestamp({ timestamp: new Date('2024-01-01T00:00:00Z') }, lookup, false);
    expect(lookup).not.toHaveBeenCalled();

    resolveMessageTimestamp({ messageId: 'm1' }, lookup, false);
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});

describe('indexMessagesById', () => {
  it('keys every message by its id', () => {
    const a = { id: 'a' } as ChatMessage;
    const b = { id: 'b' } as ChatMessage;
    expect([...indexMessagesById([a, b])]).toEqual([
      ['a', a],
      ['b', b],
    ]);
  });

  it('keeps the FIRST message for a duplicated id, exactly as the scan it replaces did', () => {
    // A list holding one id twice is a defect elsewhere; the index must not invent a different
    // answer from the one `Array.find` gave, or making the path faster changes what it renders.
    const first = { id: 'a', content: 'first' } as ChatMessage;
    const second = { id: 'a', content: 'second' } as ChatMessage;
    expect(indexMessagesById([first, second]).get('a')).toBe(first);
  });

  it('is empty for an empty conversation', () => {
    expect(indexMessagesById([]).size).toBe(0);
  });
});

describe('normalizeMessageId', () => {
  it('treats blank ids as absent', () => {
    expect(normalizeMessageId('')).toBeUndefined();
    expect(normalizeMessageId('  ')).toBeUndefined();
    expect(normalizeMessageId('abc')).toBe('abc');
  });
});

describe('computeMessageListSwitchTime', () => {
  it('uses the newest message timestamp', () => {
    const t = computeMessageListSwitchTime([
      {
        id: 'a',
        senderId: 'x',
        content: '{}',
        timestamp: new Date('2024-01-01T00:00:00Z'),
        isOwn: false,
      },
      {
        id: 'b',
        senderId: 'x',
        content: '{}',
        timestamp: new Date('2024-06-01T12:00:00Z'),
        isOwn: false,
      },
    ]);
    expect(t).toBe(Date.parse('2024-06-01T12:00:00Z'));
  });
});

describe('appMessageSentAtMs / appMsgToEnvelope', () => {
  it('reads sentAt from protobuf Long', () => {
    const sentAt = Date.parse('2024-06-01T12:00:00Z');
    const bytes = encodeAppMessage({ ...mkText('hi'), messageId: 'id-1', sentAt });
    const decoded = decodeAppMessage(bytes)!;
    expect(appMessageSentAtMs(decoded.sentAt)).toBe(sentAt);
  });

  it('prefers client sentAt over server fallback', () => {
    const sentAt = Date.parse('2024-06-01T12:00:00Z');
    const serverMs = Date.parse('2024-01-01T00:00:00Z');
    const bytes = encodeAppMessage({ ...mkText('hi'), messageId: 'id-1', sentAt });
    const decoded = decodeAppMessage(bytes)!;
    expect(resolveAppMessageTimestampMs(decoded, serverMs)).toBe(sentAt);
  });

  it('uses server fallback when sentAt is absent on the wire', () => {
    const serverMs = Date.parse('2024-03-01T08:00:00Z');
    const bytes = encodeAppMessage({ ...mkText('hi'), messageId: 'id-1' });
    const decoded = decodeAppMessage(bytes)!;
    expect(resolveAppMessageTimestampMs(decoded, serverMs)).toBe(serverMs);
    const envelope = appMsgToEnvelope(decoded, serverMs);
    expect(envelope?.options.timestamp?.getTime()).toBe(serverMs);
  });

  // Regression: while appMsgToEnvelope answered a system envelope, both DM replay paths - which
  // branch on it returning null to reach handleSystemEvent / applyReplaySystemEvent - rendered the
  // control payload's raw JSON as an ordinary message and never applied the event.
  it('returns null for a system event so the call site routes it to its handler', () => {
    const bytes = encodeAppMessage({
      ...mkSystem('channel_invitation', JSON.stringify({ channelId: 'c1' })),
      messageId: 'id-sys',
    });
    const decoded = decodeAppMessage(bytes)!;
    expect(appMsgToEnvelope(decoded)).toBeNull();
  });
});

describe('appMsgToChannelSystemEnvelope', () => {
  it('wraps a channel notice, whose data is already a localized sentence', () => {
    const serverMs = Date.parse('2024-03-01T08:00:00Z');
    const bytes = encodeAppMessage({
      ...mkSystem('memberAdded', 'Alice a ajoute Bob au groupe'),
      messageId: 'id-notice',
    });
    const decoded = decodeAppMessage(bytes)!;
    const envelope = appMsgToChannelSystemEnvelope(decoded, serverMs)!;
    expect(parseEnvelope(envelope.content)).toMatchObject({
      kind: 'system',
      text: 'Alice a ajoute Bob au groupe',
    });
    expect(envelope.options.messageId).toBe('id-notice');
    expect(envelope.options.timestamp?.getTime()).toBe(serverMs);
  });

  it('returns null for a non-system message', () => {
    const decoded = decodeAppMessage(encodeAppMessage(mkText('hi')))!;
    expect(appMsgToChannelSystemEnvelope(decoded)).toBeNull();
  });
});

describe('isStaleInboundMessage', () => {
  it('returns true for messages older than STALE_INBOUND_MS', () => {
    const now = Date.parse('2025-01-01T12:00:00Z');
    const old = new Date(now - STALE_INBOUND_MS - 1);
    expect(isStaleInboundMessage(old, now)).toBe(true);
  });

  it('returns false for recent messages', () => {
    const now = Date.now();
    expect(isStaleInboundMessage(new Date(now - 1000), now)).toBe(false);
  });
});
