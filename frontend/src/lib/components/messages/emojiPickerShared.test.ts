import { describe, it, expect, beforeEach } from 'vitest';
import { getRecentEmojis, persistRecentEmoji } from './emojiPickerShared';

describe('recent emoji, shared between the reaction picker and the composer', () => {
  beforeEach(() => localStorage.clear());

  it('starts empty with nothing persisted', () => {
    expect(getRecentEmojis()).toEqual([]);
  });

  it('reads back what it just persisted, newest first', () => {
    persistRecentEmoji('😀');
    persistRecentEmoji('🎉');
    expect(getRecentEmojis()).toEqual(['🎉', '😀']);
  });

  it('deduplicates: re-picking an emoji moves it to the front instead of repeating it', () => {
    persistRecentEmoji('😀');
    persistRecentEmoji('🎉');
    persistRecentEmoji('😀');
    expect(getRecentEmojis()).toEqual(['😀', '🎉']);
  });

  it('caps at 12, dropping the oldest', () => {
    const emojis = ['😀', '😁', '😂', '🤣', '😃', '😄', '😅', '😆', '😉', '😊', '😋', '😎', '😍'];
    for (const e of emojis) persistRecentEmoji(e);
    const recent = getRecentEmojis();
    expect(recent).toHaveLength(12);
    expect(recent[0]).toBe('😍');
    expect(recent).not.toContain('😀'); // the 13th pick, and first, pushed out
  });

  it('answers empty rather than throwing when storage holds garbage', () => {
    localStorage.setItem('canari_recent_emojis', 'not json');
    expect(getRecentEmojis()).toEqual([]);
    localStorage.setItem('canari_recent_emojis', JSON.stringify({ not: 'an array' }));
    expect(getRecentEmojis()).toEqual([]);
  });
});
