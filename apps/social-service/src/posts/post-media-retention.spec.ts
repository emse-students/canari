/**
 * Releasing feed media when the row that cited them goes away.
 *
 * A post's media are archived, which means the media service's idle sweep will never take them.
 * That is the point - but it also means the sweep is no longer the thing that reclaims them, so
 * whatever deletes the row has to say so. If it does not, a deleted post leaves an object nothing
 * will ever look at and nothing will ever remove.
 *
 * The two shapes are the trap worth pinning: a POST carries an ARRAY of media under `images`, a
 * COMMENT carries ONE as an OBJECT under `media`. Reading either with the other's accessor finds
 * nothing and fails silently, which is exactly how an orphan gets created.
 */
import { commentMediaIds, postMediaIds } from './post-media-retention.service';

const MEDIA_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEDIA_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEDIA_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

describe('postMediaIds', () => {
  it('reads a post attachment list', () => {
    expect(postMediaIds({ media: [{ mediaId: MEDIA_A }, { mediaId: MEDIA_B }] })).toEqual([
      MEDIA_A,
      MEDIA_B,
    ]);
  });

  it('survives the shapes a jsonb column can actually hold', () => {
    expect(postMediaIds({ media: [] })).toEqual([]);
    expect(postMediaIds({ media: null as never })).toEqual([]);
    // A row written by an older client, or half-migrated: skip the entry, keep the others.
    expect(postMediaIds({ media: [{ url: 'legacy' }, { mediaId: MEDIA_A }] })).toEqual([MEDIA_A]);
  });
});

describe('commentMediaIds', () => {
  it('reads the single media object a comment carries', () => {
    const comments = [
      { id: '1', media: { mediaId: MEDIA_A } },
      { id: '2' },
      { id: '3', media: { mediaId: MEDIA_B } },
    ];
    expect(commentMediaIds(comments)).toEqual([MEDIA_A, MEDIA_B]);
  });

  it('does not read a comment as if it held an array', () => {
    // The shape assertion: a post accessor pointed at comments must not quietly return nothing.
    const comments = [{ id: '1', media: { mediaId: MEDIA_C } }];
    expect(commentMediaIds(comments)).toEqual([MEDIA_C]);
    expect(postMediaIds({ media: comments as never })).toEqual([]);
  });

  it('returns nothing for a post with no comments', () => {
    expect(commentMediaIds([])).toEqual([]);
    expect(commentMediaIds(undefined)).toEqual([]);
    expect(commentMediaIds(null)).toEqual([]);
  });
});
