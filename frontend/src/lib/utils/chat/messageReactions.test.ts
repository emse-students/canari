import {
  MAX_DISTINCT_MESSAGE_REACTIONS,
  activeReactions,
  applyReaction,
  canAddDistinctReactionEmoji,
  countDistinctReactionEmojis,
  mergeReactions,
} from './messageReactions';
import type { MessageReaction } from '$lib/types';

function reactions(emojis: string[], userId = 'alice'): MessageReaction[] {
  return emojis.map((emoji, i) => ({ emoji, userId, at: 1000 + i }));
}

/** What the UI would show: the emoji of every pair that still stands. */
function standing(list: MessageReaction[]): string[] {
  return activeReactions(list)
    .map((r) => `${r.userId}${r.emoji}`)
    .sort();
}

describe('the distinct-emoji cap', () => {
  it('counts only the reactions that still stand', () => {
    // A pair taken back stays in the list carrying its removal time, so it must not keep occupying
    // a slot - otherwise a message could fill up with reactions nobody can see.
    const list: MessageReaction[] = [
      { emoji: '👍', userId: 'alice', at: 1, removed: true },
      { emoji: '🎉', userId: 'bob', at: 2 },
    ];

    expect(countDistinctReactionEmojis(list)).toBe(1);
    expect(canAddDistinctReactionEmoji(list, '🆕')).toBe(true);
  });

  it('blocks a 16th distinct emoji and allows reusing one already there', () => {
    const list = reactions(
      Array.from({ length: MAX_DISTINCT_MESSAGE_REACTIONS }, (_, i) => `e${i}`)
    );

    expect(canAddDistinctReactionEmoji(list, '🆕')).toBe(false);
    expect(canAddDistinctReactionEmoji(list, 'e0')).toBe(true);
  });

  it('is not enforced by the merge, only by the send path', () => {
    // A frame that reached the group is something that happened. A device refusing it would stay
    // permanently different from one that took it - the failure this whole file exists to remove.
    const full = reactions(
      Array.from({ length: MAX_DISTINCT_MESSAGE_REACTIONS }, (_, i) => `e${i}`)
    );

    const applied = applyReaction(full, 'bob', '🆕', 9999);

    expect(applied).not.toBeNull();
    expect(standing(applied!)).toContain('bob🆕');
  });
});

describe('applying one reaction change', () => {
  it('places a reaction that was not there', () => {
    const result = applyReaction([], 'alice', '👍', 100);

    expect(standing(result!)).toEqual(['alice👍']);
  });

  it('takes one back by keeping the pair and marking it removed', () => {
    // Dropping the entry is what used to happen, and it is why a removal could never reach a peer
    // that still held the placement: there was nothing left to send.
    const placed = applyReaction([], 'alice', '👍', 100)!;

    const removed = applyReaction(placed, 'alice', '👍', 200, true)!;

    expect(standing(removed)).toEqual([]);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({ emoji: '👍', userId: 'alice', at: 200, removed: true });
  });

  it('records a removal for a pair it never saw placed', () => {
    // Otherwise the placement arriving late afterwards would win on arrival order alone.
    const result = applyReaction([], 'alice', '👍', 200, true)!;

    expect(result).toHaveLength(1);
    expect(standing(result)).toEqual([]);
  });

  it('refuses a frame older than what it holds', () => {
    const placed = applyReaction([], 'alice', '👍', 500)!;

    expect(applyReaction(placed, 'alice', '👍', 200, true)).toBeNull();
  });

  it('refuses a frame delivered twice', () => {
    const placed = applyReaction([], 'alice', '👍', 500)!;

    expect(applyReaction(placed, 'alice', '👍', 500)).toBeNull();
  });

  it('normalises the user id, so a pair is one pair', () => {
    const placed = applyReaction([], 'ALICE', '👍', 100)!;

    expect(placed[0].userId).toBe('alice');
    expect(applyReaction(placed, 'alice', '👍', 200, true)).not.toBeNull();
  });

  it('keeps one entry per pair however many times it is toggled', () => {
    let list = applyReaction([], 'alice', '👍', 1)!;
    for (let i = 2; i < 20; i++) list = applyReaction(list, 'alice', '👍', i, i % 2 === 0)!;

    expect(list).toHaveLength(1);
  });

  it('lets a second user place the same emoji', () => {
    const mine = applyReaction([], 'alice', '👍', 100)!;

    const both = applyReaction(mine, 'bob', '👍', 101)!;

    expect(standing(both)).toEqual(['alice👍', 'bob👍']);
  });

  it('reads a stored entry from before the fields existed as an undated placement', () => {
    const legacy: MessageReaction[] = [{ emoji: '👍', userId: 'alice' }];

    expect(standing(legacy)).toEqual(['alice👍']);
    expect(applyReaction(legacy, 'alice', '👍', 1, true)).not.toBeNull();
  });
});

describe('merging a peer set', () => {
  it('adopts a removal even when we hold reactions of our own', () => {
    // The defect (D3): a bundle's reactions were adopted ONLY when the receiver held none, so a
    // removal never reached anyone holding a stale placement and the two never converged.
    const local = applyReaction([], 'alice', '👍', 100)!;
    const peer: MessageReaction[] = [{ emoji: '👍', userId: 'alice', at: 200, removed: true }];

    const merged = mergeReactions(local, peer)!;

    expect(standing(merged)).toEqual([]);
  });

  it('keeps ours when the peer is behind', () => {
    const local = applyReaction([], 'alice', '👍', 300)!;
    const peer: MessageReaction[] = [{ emoji: '👍', userId: 'alice', at: 100, removed: true }];

    expect(mergeReactions(local, peer)).toBeNull();
    expect(standing(local)).toEqual(['alice👍']);
  });

  it('reports nothing to do when the peer tells us only what we already hold', () => {
    const local = applyReaction([], 'alice', '👍', 100)!;

    expect(mergeReactions(local, [{ emoji: '👍', userId: 'alice', at: 100 }])).toBeNull();
  });

  it('takes the union across users', () => {
    const local = applyReaction([], 'alice', '👍', 100)!;

    const merged = mergeReactions(local, [{ emoji: '🎉', userId: 'bob', at: 150 }])!;

    expect(standing(merged)).toEqual(['alice👍', 'bob🎉']);
  });

  it('ignores a malformed entry rather than storing it', () => {
    const local = applyReaction([], 'alice', '👍', 100)!;

    const merged = mergeReactions(local, [
      { emoji: '', userId: 'bob', at: 200 },
      { emoji: '🎉', userId: '', at: 200 },
    ]);

    expect(merged).toBeNull();
  });

  it('converges whatever order the frames arrive in', () => {
    // The property the whole design rests on: same frames, any order, same result. Three devices
    // see a placement, a removal and a re-placement of the same pair, each in a different order.
    const frames: MessageReaction[] = [
      { emoji: '👍', userId: 'alice', at: 100 },
      { emoji: '👍', userId: 'alice', at: 200, removed: true },
      { emoji: '👍', userId: 'alice', at: 300 },
      { emoji: '🎉', userId: 'bob', at: 250 },
    ];
    const orders = [
      [0, 1, 2, 3],
      [3, 2, 1, 0],
      [2, 0, 3, 1],
      [1, 3, 0, 2],
    ];

    const results = orders.map((order) => {
      let list: MessageReaction[] = [];
      for (const i of order) list = mergeReactions(list, [frames[i]]) ?? list;
      return standing(list);
    });

    expect(results).toEqual([
      ['alice👍', 'bob🎉'],
      ['alice👍', 'bob🎉'],
      ['alice👍', 'bob🎉'],
      ['alice👍', 'bob🎉'],
    ]);
  });

  it('converges the same way through applyReaction, frame by frame', () => {
    // The live path applies frames one at a time rather than as a set; it must land in the same
    // place, or two devices differ purely by which code path delivered the frame.
    const apply = (order: number[]) => {
      const frames: [string, string, number, boolean][] = [
        ['alice', '👍', 100, false],
        ['alice', '👍', 200, true],
        ['alice', '👍', 300, false],
        ['bob', '🎉', 250, false],
      ];
      let list: MessageReaction[] = [];
      for (const i of order) {
        const [user, emoji, at, removed] = frames[i];
        list = applyReaction(list, user, emoji, at, removed) ?? list;
      }
      return standing(list);
    };

    expect(apply([0, 1, 2, 3])).toEqual(['alice👍', 'bob🎉']);
    expect(apply([3, 2, 1, 0])).toEqual(['alice👍', 'bob🎉']);
    expect(apply([1, 0, 3, 2])).toEqual(['alice👍', 'bob🎉']);
  });
});
