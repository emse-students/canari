import { describe, expect, it } from 'vitest';
import { encodeAppMessage, decodeAppMessage, mkText } from '$lib/proto/codec';
import {
  appMessageSentAtMs,
  appMsgToEnvelope,
  computeMessageListSwitchTime,
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

  it('prefers explicit timestamp in options', () => {
    const ts = new Date('2024-01-01T00:00:00Z');
    expect(resolveMessageTimestamp({ timestamp: ts }, existing, false).getTime()).toBe(
      ts.getTime()
    );
  });

  it('reuses timestamp from an existing message with the same id', () => {
    const ts = resolveMessageTimestamp({ messageId: 'm1' }, existing, false);
    expect(ts.getTime()).toBe(existing[0].timestamp.getTime());
  });

  it('uses fallbackMs when provided', () => {
    const fallback = Date.parse('2023-12-01T12:00:00Z');
    expect(resolveMessageTimestamp({}, existing, false, fallback).getTime()).toBe(fallback);
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
