import { describe, expect, it } from 'vitest';
import {
  conversationLevelRefusal,
  everyoneMentionOf,
  isConversationNotificationLevel,
  mentionsUser,
} from './conversationLevel';

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

describe('@tous', () => {
  const me = 'a'.repeat(64);

  it('a private conversation honours it from anyone; a salon only when the server vouched', () => {
    expect(everyoneMentionOf(false, false)).toBe('honoured');
    expect(everyoneMentionOf(true, true)).toBe('honoured');
    expect(everyoneMentionOf(true, false)).toBe('ignored');
  });

  it('counts as a mention of the reader only where it is honoured', () => {
    expect(mentionsUser('@[everyone] rdv 18h', me, 'honoured')).toBe(true);
    expect(mentionsUser('@[everyone] rdv 18h', me, 'ignored')).toBe(false);
    // Typed by hand, the word is text - like a name typed by hand (owner, 2026-11-26).
    expect(mentionsUser('@tous rdv 18h', me, 'honoured')).toBe(false);
    expect(mentionsUser('@everyone rdv 18h', me, 'honoured')).toBe(false);
    // A personal mention is never ignored, whatever the call to everyone.
    expect(mentionsUser(`@[${me}] @[everyone]`, me, 'ignored')).toBe(true);
  });
});
