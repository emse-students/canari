import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetConversationMoves, movedKeyOf, recordConversationMove } from './conversationMoves';

describe('conversationMoves', () => {
  afterEach(() => {
    forgetConversationMoves();
  });

  it('answers null for a key that never moved', () => {
    expect(movedKeyOf('g1')).toBeNull();
  });

  it('follows a chain of moves to the last key, case-insensitively', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    recordConversationMove('G1', 'g2');
    recordConversationMove('g2', 'g3');
    expect(movedKeyOf('g1')).toBe('g3');
    expect(movedKeyOf('g2')).toBe('g3');
  });

  it('ends the walk on a cycle instead of looping', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    recordConversationMove('g1', 'g2');
    recordConversationMove('g2', 'g1');
    expect(movedKeyOf('g1')).toBe('g2');
  });

  it('forgets every move at sign-out and says how many', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    recordConversationMove('g1', 'g2');
    expect(forgetConversationMoves()).toBe(1);
    expect(movedKeyOf('g1')).toBeNull();
  });
});
