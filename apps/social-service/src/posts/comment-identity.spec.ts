import {
  commentIdentityOf,
  commentRights,
  serveComment,
  type AssociationCard,
  type CommentViewer,
} from './comment-identity';
import { pageComments } from './comment-page';

const CARD: AssociationCard = { id: 'asso-1', name: 'BDE', slug: 'bde', logoUrl: null };
const CARDS = new Map([[CARD.id, CARD]]);

const viewer = (over: Partial<CommentViewer> = {}): CommentViewer => ({
  viewerId: 'reader',
  isGlobalAdmin: false,
  isModerator: false,
  managedAssociationIds: new Set(),
  ...over,
});

const ANON = { id: 'c1', userId: 'writer', anonymous: true, text: 'x' };
const ASSO = { id: 'c2', userId: 'writer', associationId: 'asso-1', text: 'x' };
const PLAIN = { id: 'c3', userId: 'writer', displayName: 'Ada', text: 'x' };
const POST = { authorId: 'post-author', associationId: null };

describe('an anonymous comment', () => {
  it('hides the account from an ordinary reader, the post author included', () => {
    for (const viewerId of ['reader', 'post-author']) {
      const out = serveComment(ANON, viewer({ viewerId }), POST, CARDS);
      expect(out.userId).toBeUndefined();
      expect(out.anonymous).toBe(true);
    }
  });

  it('shows the account to its writer, a moderator and a platform admin', () => {
    expect(serveComment(ANON, viewer({ viewerId: 'writer' }), POST, CARDS).userId).toBe('writer');
    expect(serveComment(ANON, viewer({ isModerator: true }), POST, CARDS).userId).toBe('writer');
    expect(serveComment(ANON, viewer({ isGlobalAdmin: true }), POST, CARDS).userId).toBe('writer');
  });

  it('says whether the writer is the post author, on a personal post only', () => {
    const byAuthor = { ...ANON, userId: 'post-author' };
    expect(serveComment(byAuthor, viewer(), POST, CARDS).byPostAuthor).toBe(true);
    expect(serveComment(ANON, viewer(), POST, CARDS).byPostAuthor).toBe(false);
    const assoPost = { authorId: 'post-author', associationId: 'asso-9' };
    expect(serveComment(byAuthor, viewer(), assoPost, CARDS)).not.toHaveProperty('byPostAuthor');
  });

  it('never carries a name even if a row had one', () => {
    const out = serveComment({ ...ANON, displayName: 'Leak' }, viewer(), POST, CARDS);
    expect(out).not.toHaveProperty('displayName');
  });
});

describe('an association comment', () => {
  it('serves the card and withholds the writer, the writer included', () => {
    const out = serveComment(ASSO, viewer({ viewerId: 'writer' }), POST, CARDS);
    expect(out.association).toEqual(CARD);
    expect(out.userId).toBeUndefined();
    expect(out).not.toHaveProperty('associationId');
  });

  it('shows the account to moderation', () => {
    expect(serveComment(ASSO, viewer({ isModerator: true }), POST, CARDS).userId).toBe('writer');
  });
});

describe('commentRights', () => {
  it('lets every holder of the right edit and delete an association comment', () => {
    const holder = viewer({ viewerId: 'other', managedAssociationIds: new Set(['asso-1']) });
    expect(commentRights(ASSO, holder)).toEqual({ canEdit: true, canDelete: true });
    expect(commentRights(ASSO, viewer({ viewerId: 'writer' }))).toEqual({
      canEdit: false,
      canDelete: false,
    });
    expect(commentRights(ASSO, viewer({ isGlobalAdmin: true })).canEdit).toBe(true);
  });

  it('lets a moderator delete an anonymous comment but never edit it', () => {
    expect(commentRights(ANON, viewer({ isModerator: true }))).toEqual({
      canEdit: false,
      canDelete: true,
    });
    expect(commentRights(ANON, viewer({ viewerId: 'writer' }))).toEqual({
      canEdit: true,
      canDelete: true,
    });
    expect(commentRights(ANON, viewer())).toEqual({ canEdit: false, canDelete: false });
  });

  it('keeps an ordinary comment as it was: the writer, or an admin to delete', () => {
    expect(commentRights(PLAIN, viewer({ viewerId: 'writer' }))).toEqual({
      canEdit: true,
      canDelete: true,
    });
    expect(commentRights(PLAIN, viewer({ isGlobalAdmin: true }))).toEqual({
      canEdit: false,
      canDelete: true,
    });
    expect(commentRights(PLAIN, viewer({ isModerator: true })).canDelete).toBe(false);
  });
});

describe('commentIdentityOf', () => {
  it('makes the two exclusive, the association winning', () => {
    expect(commentIdentityOf({ anonymous: true, associationId: 'a' })).toEqual({
      anonymous: false,
      associationId: 'a',
    });
    expect(commentIdentityOf({ anonymous: true })).toEqual({
      anonymous: true,
      associationId: null,
    });
    expect(commentIdentityOf({})).toEqual({ anonymous: false, associationId: null });
  });
});

describe('a block and a masked comment', () => {
  it('does not hide an anonymous or association comment of a blocked account', () => {
    const all = [
      { id: 'a', userId: 'blocked', anonymous: true, parentId: null },
      { id: 'b', userId: 'blocked', associationId: 'asso-1', parentId: null },
      { id: 'c', userId: 'blocked', parentId: null },
    ];
    const page = pageComments(all, { blockedIds: ['blocked'], order: 'oldest' });
    expect(page.comments.map((c) => c.id)).toEqual(['a', 'b']);
  });
});
