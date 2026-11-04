import { ConflictException, Logger } from '@nestjs/common';
import type { StoredComment } from './comment-identity';

const logger = new Logger('CommentRemoval');

/**
 * WHAT A COMMENT'S DELETE TAKES WITH IT, decided once for both delete paths
 * (`PostInteractionsService.deleteComment` and `ModerationService.deleteCommentById`).
 *
 * A delete takes the comment's DESCENDANTS, recursively (a reply of a reply goes too), and applies
 * ONE rule at every level, `mayRemove`: a node the deleter may remove goes, a node it may not stays
 * - with its own subtree judged by the same rule. A node the deleter may remove but under which
 * something stays becomes a moderation TOMBSTONE (lead's decision, 2026-11-04): its row is kept with
 * its text and media blanked and `removedByModeration: true`, so the replies it may not remove (an
 * institution's or another BDE's, owner 2026-11-03) keep their context instead of shielding it.
 *
 * A tombstone left with no reply is removed (`pruneEmptyTombstones`), here and on every later delete
 * - so the trace disappears with the last thing it was kept for.
 */

/** What `planCommentRemoval` decided. */
export interface CommentRemovalPlan {
  /** The post's comments after the delete: what to store. */
  comments: StoredComment[];
  /** The rows dropped (for their media and for the client's list). */
  removed: StoredComment[];
  /** The rows turned into tombstones, AS THEY WERE (their media goes too), and as now stored. */
  tombstoned: { before: StoredComment; after: StoredComment }[];
}

/**
 * The fields a tombstone keeps: where it sits and when - and NO account (lead's review of #2999). A
 * tombstone with its writer's `userId` but without its `anonymous` / `associationId` would be hidden
 * by the block filters from a reader blocked with that writer: a probe of who wrote an anonymous or
 * an association's comment. Nothing needs the account any more (the comment is gone; account
 * erasure has nothing left to find in it).
 */
function tombstoneOf(c: StoredComment, at: string): StoredComment {
  return {
    id: c.id,
    parentId: c.parentId ?? null,
    createdAt: c.createdAt,
    text: '',
    likes: [],
    removedByModeration: true,
    removedAt: at,
  };
}

/**
 * 409 `code`: the comment was removed by moderation - a tombstone takes no reply and no like, so
 * nothing written to it can notify, or reach, the moderated writer.
 */
export const COMMENT_REMOVED_BY_MODERATION = 'COMMENT_REMOVED_BY_MODERATION';

/**
 * Refuses an act on a moderation tombstone, typed (409 `COMMENT_REMOVED_BY_MODERATION`): replying
 * to it or liking it. A refusal and never a silent no-op: the client that offered the control holds a
 * stale row, and says so.
 */
export function refuseRemovedByModeration(c: StoredComment, act: 'reply' | 'like'): void {
  if (c.removedByModeration !== true) return;
  logger.warn(`[MODERATION] ${act} refused: comment ${String(c.id).slice(0, 12)} is a tombstone`);
  throw new ConflictException({
    code: COMMENT_REMOVED_BY_MODERATION,
    message: 'This comment was removed by moderation',
  });
}

/** The ids of `rows`, those that carry one. */
export function idsOfRows(rows: readonly StoredComment[]): string[] {
  return rows.map((c) => c.id).filter((id): id is string => typeof id === 'string' && id !== '');
}

/** The rows whose media a delete releases: every row dropped, and each new tombstone's original. */
export function rowsReleasedBy(plan: CommentRemovalPlan): StoredComment[] {
  return [...plan.removed, ...plan.tombstoned.map((t) => t.before)];
}

/**
 * How many COUNTED comments a delete took out of the post's count: the live rows it dropped and the
 * live rows it turned into tombstones. A tombstone is not counted (`commentCount`), so pruning one
 * takes nothing out.
 */
export function countedOutBy(plan: CommentRemovalPlan): number {
  return plan.removed.filter((c) => c.removedByModeration !== true).length + plan.tombstoned.length;
}

/** The children of each comment, by parent id. */
function childrenByParent(list: readonly StoredComment[]): Map<string, StoredComment[]> {
  const out = new Map<string, StoredComment[]>();
  for (const c of list) {
    if (!c.parentId) continue;
    const held = out.get(c.parentId);
    if (held) held.push(c);
    else out.set(c.parentId, [c]);
  }
  return out;
}

/**
 * Removes every tombstone with no reply left, repeatedly (a tombstone whose only reply was a
 * tombstone goes in the same pass). Returns the kept list and the pruned rows.
 */
export function pruneEmptyTombstones(list: readonly StoredComment[]): {
  comments: StoredComment[];
  pruned: StoredComment[];
} {
  let kept = [...list];
  const pruned: StoredComment[] = [];
  for (;;) {
    const parents = new Set(kept.map((c) => c.parentId).filter((id): id is string => !!id));
    const empty = kept.filter((c) => c.removedByModeration === true && !parents.has(c.id ?? ''));
    if (empty.length === 0) return { comments: kept, pruned };
    const drop = new Set(empty);
    pruned.push(...empty);
    kept = kept.filter((c) => !drop.has(c));
  }
}

/**
 * Plans the delete of comment `rootId` from `list`. The caller has ALREADY decided the root may go
 * (`commentRights(...).canDelete`); `mayRemove` judges every descendant. A cycle in stored parent
 * ids (never written, but the data is free JSON) is cut by the visited set rather than looping.
 *
 * @param at The tombstones' `removedAt` (ISO), given by the caller so the plan is a pure function.
 */
export function planCommentRemoval(
  list: readonly StoredComment[],
  rootId: string,
  mayRemove: (c: StoredComment) => boolean,
  at: string
): CommentRemovalPlan {
  const children = childrenByParent(list);
  const drop = new Set<StoredComment>();
  const tombstones = new Map<StoredComment, StoredComment>();
  const visited = new Set<string>();

  /** Decides `node` and its subtree; answers whether a row for `node` STAYS. */
  const visit = (node: StoredComment, isRoot: boolean): boolean => {
    const id = node.id ?? '';
    // Met again only through a cycle: already decided, and nothing new stays because of it.
    if (visited.has(id)) return false;
    visited.add(id);
    let somethingStays = false;
    for (const child of children.get(id) ?? []) {
      if (visit(child, false)) somethingStays = true;
    }
    if (!isRoot && !mayRemove(node)) return true;
    if (somethingStays) {
      tombstones.set(node, node.removedByModeration === true ? node : tombstoneOf(node, at));
      return true;
    }
    drop.add(node);
    return false;
  };

  const root = list.find((c) => c.id === rootId);
  if (!root) return { comments: [...list], removed: [], tombstoned: [] };
  visit(root, true);

  const next = list.filter((c) => !drop.has(c)).map((c) => tombstones.get(c) ?? c);
  const { comments, pruned } = pruneEmptyTombstones(next);
  return {
    comments,
    removed: [...list.filter((c) => drop.has(c)), ...pruned],
    tombstoned: [...tombstones.entries()]
      .filter(([before]) => before.removedByModeration !== true)
      .map(([before, after]) => ({ before, after })),
  };
}
