/**
 * The reaction path every post surface shares (`postReaction.ts`): the optimistic map, and the
 * announcement that carries a like given in the reel viewer to the cards on screen.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  onPostReactions,
  publishPostReactions,
  sendPostReaction,
  toggledReactions,
} from './postReaction';
import { addReaction, removeReaction } from '$lib/posts/api';

vi.mock('$lib/posts/api', () => ({ addReaction: vi.fn(), removeReaction: vi.fn() }));
vi.mock('$lib/moderation/muteCheck', () => ({
  assertNotMuted: vi.fn(() => Promise.resolve()),
  cachedMuteStatus: vi.fn(() => null),
}));

describe('sendPostReaction', () => {
  it("hands back the server's tally with its map, so no caller keeps a stale one", async () => {
    vi.mocked(addReaction).mockResolvedValue({
      ok: true,
      reactions: { reader: "J'aime" },
      otherReactionCounts: { "J'aime": 4 },
    });
    expect(await sendPostReaction('p1', "J'aime", false)).toEqual({
      reactions: { reader: "J'aime" },
      otherReactionCounts: { "J'aime": 4 },
    });
    // Taken back: the answer's tally - or its absence, for a reader nothing is withheld from.
    vi.mocked(removeReaction).mockResolvedValue({ ok: true, reactions: {} });
    expect(await sendPostReaction('p1', "J'aime", true)).toEqual({
      reactions: {},
      otherReactionCounts: undefined,
    });
  });
});

describe('toggledReactions', () => {
  it('adds a reaction, replaces another, and takes the same one back', () => {
    expect(toggledReactions({}, 'a', "J'aime")).toEqual({
      next: { a: "J'aime" },
      wasReacted: false,
    });
    expect(toggledReactions({ a: 'Rire', b: 'Rire' }, 'a', "J'aime")).toEqual({
      next: { a: "J'aime", b: 'Rire' },
      wasReacted: false,
    });
    expect(toggledReactions({ a: "J'aime", b: 'Rire' }, 'a', "J'aime")).toEqual({
      next: { b: 'Rire' },
      wasReacted: true,
    });
  });

  it('leaves the map it was given untouched, which is what a rollback restores', () => {
    const before = { a: "J'aime" };
    toggledReactions(before, 'a', "J'aime");
    expect(before).toEqual({ a: "J'aime" });
  });
});

describe('publishPostReactions', () => {
  it('reaches the listeners of that post only, and none once they left', () => {
    const mine = vi.fn();
    const other = vi.fn();
    const stop = onPostReactions('p1', mine);
    onPostReactions('p2', other);

    publishPostReactions('p1', { reactions: { a: "J'aime" }, otherReactionCounts: { Bravo: 2 } });
    expect(mine).toHaveBeenCalledWith({
      reactions: { a: "J'aime" },
      otherReactionCounts: { Bravo: 2 },
    });
    expect(other).not.toHaveBeenCalled();

    stop();
    publishPostReactions('p1', { reactions: {} });
    expect(mine).toHaveBeenCalledTimes(1);
  });

  it('a listener that throws does not stop the next one', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const after = vi.fn();
    const a = onPostReactions('p3', () => {
      throw new Error('broken card');
    });
    const b = onPostReactions('p3', after);

    publishPostReactions('p3', { reactions: { a: "J'aime" } });

    expect(after).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    a();
    b();
    error.mockRestore();
  });
});
