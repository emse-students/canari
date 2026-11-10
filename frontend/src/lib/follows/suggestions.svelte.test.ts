/**
 * WHERE THE FEED DRAWS ITS SUGGESTIONS, AND IN WHAT ORDER (engagement WP-6): the one placement
 * rule of decisions 3 and 7, and the interleaving of people and entities.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('$lib/stores/user', () => ({ currentUserId: () => 'me' }));

import {
  CAROUSEL_CARDS_MAX,
  FEED_CAROUSEL_AFTER_POSTS,
  ONBOARDING_FOLLOWS_BELOW,
  feedSuggestionPlacement,
  interleaveCards,
} from './suggestions.svelte';

const person = (userId: string) => ({ userId, mutual: 0, faces: [] });
const entity = (id: string) => ({ id, name: id, slug: id, logoUrl: null, type: 'association' });

describe('feedSuggestionPlacement', () => {
  const base = { feed: 'all', postCount: 10, followingCount: 20, openCards: 4 };

  it('draws only in Mon espace and Suivis, and only while a card is open', () => {
    expect(feedSuggestionPlacement(base)).toBe('inline');
    expect(feedSuggestionPlacement({ ...base, feed: 'followed' })).toBe('inline');
    expect(feedSuggestionPlacement({ ...base, feed: 'associations' })).toBeNull();
    expect(feedSuggestionPlacement({ ...base, feed: 'custom' })).toBeNull();
    expect(feedSuggestionPlacement({ ...base, openCards: 0 })).toBeNull();
  });

  it('an empty Suivis feed is the page body, whatever the follow count', () => {
    expect(feedSuggestionPlacement({ ...base, feed: 'followed', postCount: 0 })).toBe('page');
    expect(
      feedSuggestionPlacement({ ...base, feed: 'followed', postCount: 0, followingCount: 0 })
    ).toBe('page');
  });

  it('a reader who follows fewer than 5 accounts gets the banner (L12), 5 does not', () => {
    expect(ONBOARDING_FOLLOWS_BELOW).toBe(5);
    expect(feedSuggestionPlacement({ ...base, followingCount: 4 })).toBe('banner');
    expect(feedSuggestionPlacement({ ...base, followingCount: 4, postCount: 0 })).toBe('banner');
    expect(feedSuggestionPlacement({ ...base, followingCount: 5 })).toBe('inline');
  });

  it('the inline carousel needs the third post to exist', () => {
    expect(FEED_CAROUSEL_AFTER_POSTS).toBe(3);
    expect(feedSuggestionPlacement({ ...base, postCount: 2 })).toBeNull();
    expect(feedSuggestionPlacement({ ...base, postCount: 3 })).toBe('inline');
  });
});

describe('interleaveCards', () => {
  it('alternates a person and an entity, a person first', () => {
    const cards = interleaveCards({
      people: [person('a'), person('b')],
      entities: [entity('x'), entity('y')],
    });
    expect(cards.map((c) => `${c.kind}:${c.id}`)).toEqual([
      'user:a',
      'association:x',
      'user:b',
      'association:y',
    ]);
  });

  it('a short source leaves the rest to the longer, and the row stops at ten', () => {
    const people = Array.from({ length: 20 }, (_, i) => person(`p${i}`));
    const cards = interleaveCards({ people, entities: [entity('x')] });
    expect(cards).toHaveLength(CAROUSEL_CARDS_MAX);
    expect(cards.map((c) => c.id).slice(0, 4)).toEqual(['p0', 'x', 'p1', 'p2']);
    expect(interleaveCards({ people: [], entities: [] })).toEqual([]);
  });
});
