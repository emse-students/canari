/**
 * `PostCardLedger`: a served row replaces a card's copy, except a field a write of the card still
 * carries or answered AFTER the row's read was issued (reviews of #1896).
 */
import type { PostEntity } from '$lib/posts/api';
import { nextPostSequence, PostCardLedger, servedAt, stampServed } from './postCardSync';

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

function served(issuedAt: number, extra: Partial<PostEntity>): PostEntity {
  const r = row(extra);
  stampServed(r, issuedAt);
  return r;
}

const local = row({
  canVote: false,
  reactions: { alice: 'like' },
  comments: [{ id: 'pending-1', userId: 'alice', text: 'hi', likes: [], createdAt: 'now' }],
  markdown: 'stored',
});
const answer = {
  canVote: true,
  canManage: true,
  reactions: { bob: 'love' },
  comments: [],
  markdown: 'served',
};

describe('PostCardLedger.adopt', () => {
  it('takes everything from a served row when the card wrote nothing', () => {
    const ledger = new PostCardLedger(local);
    const s = served(nextPostSequence(), answer);
    expect(ledger.adopt(local, s)).toEqual(s);
    expect(ledger.served).toBe(s);
  });

  it('keeps a field whose write is still pending, and nothing else', () => {
    const ledger = new PostCardLedger(local);
    ledger.begin(['reactions', 'comments']);
    const next = ledger.adopt(local, served(nextPostSequence(), answer));
    expect(next.reactions).toEqual({ alice: 'like' });
    expect(next.comments?.map((c) => c.id)).toEqual(['pending-1']);
    expect(next.canVote).toBe(true);
    expect(next.markdown).toBe('served');
  });

  it('keeps a field whose write ANSWERED after the row was read, then takes a later read', () => {
    const ledger = new PostCardLedger(local);
    const getIssuedAt = nextPostSequence(); // the feed's GET leaves
    ledger.begin(['reactions']); // the tap
    ledger.end(['reactions']); // its POST answers first
    expect(ledger.adopt(local, served(getIssuedAt, answer)).reactions).toEqual({ alice: 'like' });
    expect(ledger.adopt(local, served(nextPostSequence(), answer)).reactions).toEqual({
      bob: 'love',
    });
  });

  it('a write applied on its answer (pin, edit) is protected the same way', () => {
    const ledger = new PostCardLedger(local);
    const getIssuedAt = nextPostSequence();
    ledger.answered(['pinned']);
    const pinned = { ...local, pinned: true };
    expect(ledger.adopt(pinned, served(getIssuedAt, { pinned: false })).pinned).toBe(true);
  });

  it('an unstamped row (a stored copy) never overrides a field written this session', () => {
    const ledger = new PostCardLedger(local);
    ledger.answered(['reactions']);
    expect(ledger.adopt(local, row({ reactions: {} })).reactions).toEqual({ alice: 'like' });
    expect(servedAt(row({}))).toBe(0);
  });

  it('a held field is never taken from a feed row, only from a read of the post', () => {
    const ledger = new PostCardLedger(local);
    ledger.hold('comments');
    expect(ledger.adopt(local, served(nextPostSequence(), answer)).comments).toBe(local.comments);
    const full = [{ id: 'c9', userId: 'bob', text: 'all', likes: [], createdAt: 'now' }];
    expect(ledger.mergeRead(local, { comments: full }, nextPostSequence()).comments).toBe(full);
  });
});

describe('PostCardLedger.mergeRead', () => {
  it('skips a field a write answered after the read was issued', () => {
    const ledger = new PostCardLedger(local);
    const issuedAt = nextPostSequence();
    ledger.answered(['comments']);
    const next = ledger.mergeRead(local, { comments: [], markdown: 'fresh' }, issuedAt);
    expect(next.comments).toBe(local.comments);
    expect(next.markdown).toBe('fresh');
  });
});

describe('PostCardLedger.rollback', () => {
  it('restores the pre-tap value when no row arrived while the write was out', () => {
    const ledger = new PostCardLedger(local);
    const token = ledger.begin(['reactions']);
    const next = ledger.rollback({ ...local, markdown: 'kept' }, 'reactions', {}, token);
    expect(next.reactions).toEqual({});
    expect(next.markdown).toBe('kept');
  });

  it('restores the NEWEST served value when a row was adopted while the write was out', () => {
    const ledger = new PostCardLedger(local);
    const token = ledger.begin(['reactions']);
    const s = served(nextPostSequence(), answer);
    const adopted = ledger.adopt(local, s);
    const next = ledger.rollback(adopted, 'reactions', {}, token);
    expect(next.reactions).toEqual({ bob: 'love' });
    expect(next.markdown).toBe('served');
  });

  it('keeps the pre-tap value when the adopted row is older than another answered write', () => {
    const ledger = new PostCardLedger(local);
    const oldRead = nextPostSequence();
    ledger.begin(['reactions']);
    ledger.end(['reactions']); // an earlier write, answered after `oldRead` left
    const token = ledger.begin(['reactions']);
    ledger.adopt(local, served(oldRead, answer));
    expect(ledger.rollback(local, 'reactions', { alice: 'like' }, token).reactions).toEqual({
      alice: 'like',
    });
  });
});
