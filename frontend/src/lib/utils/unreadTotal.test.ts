import { describe, expect, it } from 'vitest';
import { channelUnreadCount, communityHasUnread, totalUnreadMessages } from './unreadTotal';

describe('channelUnreadCount and communityHasUnread', () => {
  const channels = [{ id: 'channel-a' }, { id: 'channel-b', unreadCount: 2 }];

  it('prefers the live conversation count over the listing row, and treats absent as zero', () => {
    const live = new Map([['channel-b', { unreadCount: 0 }]]);
    expect(channelUnreadCount(channels[1], live)).toBe(0);
    expect(channelUnreadCount(channels[1], new Map())).toBe(2);
    expect(channelUnreadCount(channels[0], new Map())).toBe(0);
  });

  it('lights when any salon has something to read and clears when the last one is read', () => {
    const live = new Map<string, { unreadCount?: number }>([['channel-a', { unreadCount: 1 }]]);
    expect(communityHasUnread(channels, live)).toBe(true);
    live.set('channel-a', { unreadCount: 0 });
    live.set('channel-b', { unreadCount: 0 });
    expect(communityHasUnread(channels, live)).toBe(false);
  });

  it('is false for a community with no salon', () => {
    expect(communityHasUnread([], new Map())).toBe(false);
  });
});

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
