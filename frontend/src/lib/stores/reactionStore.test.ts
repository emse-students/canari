import { describe, it, expect, beforeEach } from 'vitest';
import {
  applyLocalChannelReaction,
  channelReactionMap,
  flattenReactionTally,
  getChannelReactions,
  setChannelReactions,
} from './reactionStore.svelte';

describe('channel reaction store', () => {
  beforeEach(() => channelReactionMap().clear());

  it('flattens the server tally into one entry per (emoji, user)', () => {
    expect(flattenReactionTally({ '👍': ['u1', 'u2'], '🔥': ['u2'] })).toEqual([
      { emoji: '👍', userId: 'u1' },
      { emoji: '👍', userId: 'u2' },
      { emoji: '🔥', userId: 'u2' },
    ]);
  });

  it('lowercases user ids so ownership matches the normalised current user', () => {
    expect(flattenReactionTally({ '👍': ['Camille.Dupont'] })).toEqual([
      { emoji: '👍', userId: 'camille.dupont' },
    ]);
  });

  it('treats a missing or malformed tally as no reactions', () => {
    expect(flattenReactionTally(undefined)).toEqual([]);
    expect(flattenReactionTally(null)).toEqual([]);
    // A row predating the feature, or a key whose value is not a list.
    expect(flattenReactionTally({ '👍': null as unknown as string[] })).toEqual([]);
  });

  it('replaces a message tally wholesale rather than merging into it', () => {
    setChannelReactions('m1', { '👍': ['u1', 'u2'] });
    setChannelReactions('m1', { '🔥': ['u3'] });
    expect(getChannelReactions('m1')).toEqual([{ emoji: '🔥', userId: 'u3' }]);
  });

  it('applies a local toggle both ways, and twice is a no-op', () => {
    setChannelReactions('m1', { '👍': ['u2'] });

    applyLocalChannelReaction('m1', 'u1', '👍');
    expect(getChannelReactions('m1')).toEqual([
      { emoji: '👍', userId: 'u2' },
      { emoji: '👍', userId: 'u1' },
    ]);

    // The toggle is its own inverse - that is what the failed-request rollback relies on.
    applyLocalChannelReaction('m1', 'u1', '👍');
    expect(getChannelReactions('m1')).toEqual([{ emoji: '👍', userId: 'u2' }]);
  });

  it('ignores an empty message id, user or emoji instead of storing a phantom entry', () => {
    applyLocalChannelReaction('', 'u1', '👍');
    applyLocalChannelReaction('m1', '', '👍');
    applyLocalChannelReaction('m1', 'u1', '');
    setChannelReactions('', { '👍': ['u1'] });
    expect(channelReactionMap().size).toBe(0);
  });

  it('reports no reactions for a message nothing is known about', () => {
    expect(getChannelReactions('never-seen')).toEqual([]);
  });
});
