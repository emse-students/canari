import {
  applyChannelReactionFrame,
  channelReactionMap,
  getChannelReactions,
} from './reactionStore.svelte';

/**
 * The channel reaction store (WP-40).
 *
 * A channel reaction is an encrypted message now, so this store no longer receives an authoritative
 * server tally - it receives FRAMES, in whatever order the network and a 200-row page hand them
 * over. Every test here is about the one property that makes that safe: two devices that saw the
 * same frames in any order hold the same set.
 */

describe('channel reaction store', () => {
  beforeEach(() => channelReactionMap().clear());

  it('records a placement, lower-casing the user id', () => {
    expect(applyChannelReactionFrame('m1', 'Camille.Dupont', '👍', 10)).toBe(true);
    expect(getChannelReactions('m1')).toEqual([
      { emoji: '👍', userId: 'camille.dupont', at: 10, removed: false },
    ]);
  });

  it('lets a later removal take a placement back', () => {
    applyChannelReactionFrame('m1', 'u1', '👍', 10);
    expect(applyChannelReactionFrame('m1', 'u1', '👍', 20, true)).toBe(true);
    expect(getChannelReactions('m1')[0].removed).toBe(true);
  });

  it('ignores a frame that lost the race, and a replay of one it holds', () => {
    applyChannelReactionFrame('m1', 'u1', '👍', 20, true);
    // A placement that was superseded must not come back because it arrived second.
    expect(applyChannelReactionFrame('m1', 'u1', '👍', 10)).toBe(false);
    // Replaying a frame onto its own result is a no-op, not a flip.
    expect(applyChannelReactionFrame('m1', 'u1', '👍', 20, true)).toBe(false);
    expect(getChannelReactions('m1')[0].removed).toBe(true);
  });

  it('converges whatever order the frames arrive in', () => {
    applyChannelReactionFrame('m1', 'u1', '👍', 30, true);
    applyChannelReactionFrame('m1', 'u1', '👍', 10);
    applyChannelReactionFrame('m1', 'u1', '👍', 20, false);
    const forwards = getChannelReactions('m1');

    channelReactionMap().clear();
    applyChannelReactionFrame('m1', 'u1', '👍', 10);
    applyChannelReactionFrame('m1', 'u1', '👍', 20, false);
    applyChannelReactionFrame('m1', 'u1', '👍', 30, true);

    // Reading a history page newest-first is exactly this, and it must not change the answer.
    expect(getChannelReactions('m1')).toEqual(forwards);
  });

  it('keeps one entry per (user, emoji) pair and one per message', () => {
    applyChannelReactionFrame('m1', 'u1', '👍', 10);
    applyChannelReactionFrame('m1', 'u2', '👍', 10);
    applyChannelReactionFrame('m1', 'u1', '🔥', 10);
    applyChannelReactionFrame('m2', 'u1', '👍', 10);
    expect(getChannelReactions('m1')).toHaveLength(3);
    expect(getChannelReactions('m2')).toHaveLength(1);
  });

  it('ignores an incomplete frame rather than storing half of one', () => {
    expect(applyChannelReactionFrame('', 'u1', '👍', 10)).toBe(false);
    expect(applyChannelReactionFrame('m1', '', '👍', 10)).toBe(false);
    expect(applyChannelReactionFrame('m1', 'u1', '', 10)).toBe(false);
    expect(channelReactionMap().size).toBe(0);
  });

  it('answers an empty list for a message nobody reacted to', () => {
    expect(getChannelReactions('never-seen')).toEqual([]);
  });
});
