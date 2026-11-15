import { authorNoticeKind } from './post-activity-notice';

describe('authorNoticeKind (owner, 2026-11-15)', () => {
  const base = { authorId: 'a', parentWriterId: null, mentionedIds: [] as string[] };
  it('is a plain comment when nothing targets the author', () => {
    expect(authorNoticeKind({ ...base, parentWriterId: 'x', mentionedIds: ['y'] })).toBe('comment');
  });
  it('is a reply to the author comment, which wins over a mention', () => {
    expect(authorNoticeKind({ ...base, parentWriterId: 'a', mentionedIds: ['a'] })).toBe('reply');
  });
  it('is a reply when the parent speaks for an association the author holds', () => {
    expect(authorNoticeKind({ ...base, authorHoldsParentAssociation: true })).toBe('reply');
  });
  it('compares the author id with the lowercased mention ids', () => {
    expect(authorNoticeKind({ ...base, authorId: 'AbC', mentionedIds: ['abc'] })).toBe('mention');
  });
  it('is a mention when the text names the author', () => {
    expect(authorNoticeKind({ ...base, mentionedIds: ['a'] })).toBe('mention');
  });
});
