/** The longest comment, in characters. The client copy is `COMMENT_MAX_LENGTH` in `frontend/src/lib/posts/api.ts`. */
export const COMMENT_MAX_LENGTH = 2000;

/** Threads per page when the caller names none, and the most it may ask for. */
export const COMMENT_PAGE_DEFAULT = 20;
export const COMMENT_PAGE_MAX = 50;

export type CommentOrder = 'recent' | 'oldest';

interface StoredComment {
  id: string;
  userId?: string;
  parentId?: string | null;
}

export interface CommentPage<T extends StoredComment> {
  /** Whole threads: each top-level comment followed by every one of its descendants. */
  comments: T[];
  /** Position of the last thread head returned; pass it back as `cursor` for the next page. */
  nextCursor: number | null;
  hasMore: boolean;
}

/**
 * Cuts one page of WHOLE THREADS out of the stored comment array.
 *
 * A page never splits a thread - a reply is useless without its parent - so the unit is the
 * top-level comment and its descendants. The cursor is the array POSITION of a thread head
 * (stable, because comments are only appended or removed whole), exclusive: `recent` walks to
 * lower positions, `oldest` to higher ones. A comment by a blocked account is dropped, and so is
 * the whole thread under a blocked head, since the reader would see replies to nothing.
 */
export function pageComments<T extends StoredComment>(
  all: T[],
  opts: { cursor?: number | null; limit?: number; order?: CommentOrder; blockedIds?: string[] }
): CommentPage<T> {
  const order = opts.order ?? 'recent';
  const limit = Math.min(Math.max(opts.limit ?? COMMENT_PAGE_DEFAULT, 1), COMMENT_PAGE_MAX);
  const blocked = new Set(opts.blockedIds ?? []);
  const visible = (c: T) => !blocked.has(c.userId ?? '');

  const heads: { c: T; pos: number }[] = [];
  all.forEach((c, pos) => {
    if (!c.parentId && visible(c)) heads.push({ c, pos });
  });
  if (order === 'recent') heads.reverse();

  const cursor = opts.cursor;
  const rest =
    cursor === null || cursor === undefined
      ? heads
      : heads.filter((h) => (order === 'recent' ? h.pos < cursor : h.pos > cursor));
  const slice = rest.slice(0, limit);

  // Descendants by walking parentId links once, so a reply to a reply stays in its thread.
  const children = new Map<string, T[]>();
  for (const c of all) {
    if (!c.parentId || !visible(c)) continue;
    const list = children.get(c.parentId) ?? [];
    list.push(c);
    children.set(c.parentId, list);
  }
  const thread = (head: T): T[] => {
    const out: T[] = [head];
    for (const child of children.get(head.id) ?? []) out.push(...thread(child));
    return out;
  };

  return {
    comments: slice.flatMap((h) => thread(h.c)),
    nextCursor: slice.length > 0 ? slice[slice.length - 1].pos : null,
    hasMore: rest.length > slice.length,
  };
}
