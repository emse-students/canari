/**
 * A served row replaces a card's copy, except what a write of this reader is still carrying
 * (`adoptServedPost`, review of #1896).
 */
import type { PostEntity } from '$lib/posts/api';
import { adoptServedPost, noInteractionsInFlight } from './postCardSync';

function row(extra: Partial<PostEntity>): PostEntity {
  return {
    id: 'p1',
    markdown: 'x',
    mentions: [],
    links: [],
    media: [],
    images: [],
    polls: [],
    createdAt: '2026-10-15T08:00:00.000Z',
    publishedAt: '2026-10-15T08:00:00.000Z',
    updatedAt: '2026-10-15T08:00:00.000Z',
    ...extra,
  };
}

const local = row({
  canVote: false,
  reactions: { alice: 'like' },
  comments: [{ id: 'pending-1', userId: 'alice', text: 'hi', likes: [], createdAt: 'now' }],
  markdown: 'stored',
});
const served = row({
  canVote: true,
  canManage: true,
  reactions: { bob: 'love' },
  comments: [],
  markdown: 'served',
});

describe('adoptServedPost', () => {
  it('takes everything from the served row when nothing is in flight', () => {
    expect(adoptServedPost(local, served, noInteractionsInFlight())).toEqual(served);
  });

  it('keeps an optimistic reaction or comment still waiting for its answer, and nothing else', () => {
    const next = adoptServedPost(local, served, { reactions: 1, polls: 0, comments: 1 });
    expect(next.reactions).toEqual({ alice: 'like' });
    expect(next.comments?.map((c) => c.id)).toEqual(['pending-1']);
    expect(next.canVote).toBe(true);
    expect(next.canManage).toBe(true);
    expect(next.markdown).toBe('served');
  });

  it('keeps a vote in flight', () => {
    const voted = row({
      polls: [
        {
          id: 'q',
          question: '?',
          options: [],
          multipleChoice: false,
          votesByUser: { alice: ['o'] },
        },
      ],
    });
    expect(adoptServedPost(voted, served, { reactions: 0, polls: 1, comments: 0 }).polls).toBe(
      voted.polls
    );
  });
});
