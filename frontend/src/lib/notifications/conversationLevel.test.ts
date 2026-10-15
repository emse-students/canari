import { describe, expect, it } from 'vitest';
import { conversationLevelRefusal, isConversationNotificationLevel } from './conversationLevel';

describe('conversationLevelRefusal', () => {
  it('raises everything at all', () => {
    expect(conversationLevelRefusal('all', false)).toBeNull();
    expect(conversationLevelRefusal('all', true)).toBeNull();
  });

  it('raises nothing at none, a mention included', () => {
    expect(conversationLevelRefusal('none', false)).not.toBeNull();
    expect(conversationLevelRefusal('none', true)).not.toBeNull();
  });

  it('raises only a mention of this account at mentions', () => {
    expect(conversationLevelRefusal('mentions', true)).toBeNull();
    expect(conversationLevelRefusal('mentions', false)).not.toBeNull();
  });
});

describe('isConversationNotificationLevel', () => {
  it('accepts the three levels and nothing else', () => {
    for (const l of ['all', 'mentions', 'none'])
      expect(isConversationNotificationLevel(l)).toBe(true);
    for (const l of ['', 'mute', null, 1]) expect(isConversationNotificationLevel(l)).toBe(false);
  });
});
