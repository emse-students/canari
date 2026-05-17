import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '$lib/types';
import { groupMessages } from './messageGrouping';

function msg(overrides: Partial<ChatMessage> & Pick<ChatMessage, 'id'>): ChatMessage {
  return {
    senderId: 'u1',
    content: '{}',
    timestamp: new Date('2024-03-01T10:00:00Z'),
    isOwn: false,
    ...overrides,
  };
}

describe('groupMessages', () => {
  it('does not throw when a message has an invalid timestamp', () => {
    const messages: ChatMessage[] = [
      msg({ id: '1', timestamp: new Date('invalid') }),
      msg({ id: '2', timestamp: new Date('2024-03-01T10:05:00Z') }),
    ];

    expect(() => groupMessages(messages)).not.toThrow();
    expect(groupMessages(messages).some((g) => g.type === 'message')).toBe(true);
  });
});
