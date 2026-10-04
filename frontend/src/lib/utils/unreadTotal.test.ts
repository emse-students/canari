import { describe, expect, it } from 'vitest';
import { totalUnreadMessages } from './unreadTotal';

describe('totalUnreadMessages', () => {
  it('can total only the conversations belonging to one navigation place', () => {
    const conversations = [
      { id: 'dm-user', unreadCount: 2 },
      { id: 'channel-salon', unreadCount: 3 },
      { id: 'group-team', unreadCount: 1 },
    ];

    expect(totalUnreadMessages(conversations)).toBe(6);
    expect(
      totalUnreadMessages(
        conversations,
        (conversation) => conversation.id?.startsWith('channel-') ?? false
      )
    ).toBe(3);
    expect(
      totalUnreadMessages(conversations, (conversation) => !conversation.id?.startsWith('channel-'))
    ).toBe(3);
  });
});
