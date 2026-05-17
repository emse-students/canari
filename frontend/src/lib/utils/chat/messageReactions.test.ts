import { describe, expect, it } from 'vitest';
import {
  MAX_DISTINCT_MESSAGE_REACTIONS,
  canAddDistinctReactionEmoji,
  toggleMessageReaction,
} from './messageReactions';
import type { MessageReaction } from '$lib/types';

function reactions(emojis: string[], userId = 'alice'): MessageReaction[] {
  return emojis.map((emoji) => ({ emoji, userId }));
}

describe('messageReactions', () => {
  it('allows toggling off an existing reaction when at the cap', () => {
    const list = reactions(
      Array.from({ length: MAX_DISTINCT_MESSAGE_REACTIONS }, (_, i) => `e${i}`)
    );
    const result = toggleMessageReaction(list, 'alice', 'e0');
    expect(result).not.toBeNull();
    expect(result!.length).toBe(MAX_DISTINCT_MESSAGE_REACTIONS - 1);
  });

  it('blocks a 16th distinct emoji', () => {
    const list = reactions(
      Array.from({ length: MAX_DISTINCT_MESSAGE_REACTIONS }, (_, i) => `e${i}`)
    );
    expect(toggleMessageReaction(list, 'alice', '🆕')).toBeNull();
  });

  it('allows another user to use an existing emoji type', () => {
    const list = reactions(['👍'], 'bob');
    expect(canAddDistinctReactionEmoji(list, '👍')).toBe(true);
    const result = toggleMessageReaction(list, 'alice', '👍');
    expect(result).toHaveLength(2);
  });
});
