import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AssociationsService } from '../associations/associations.service';
import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';
import { Post } from './entities/post.entity';
import type { ModerationTarget } from '../spaces/bde-moderation';

/**
 * WHO A COMMENT SPEAKS AS, AND WHAT EACH READER MAY KNOW OF IT (2026-10-21).
 *
 * A stored comment keeps the REAL `userId` of its writer whatever it says it is - the mute, the
 * report, the ban and the account erasure all act on that account. What differs is what is SERVED:
 *
 * - `anonymous: true` - no name is stored at all, and `userId` is withheld from every reader but
 *   the writer, a content moderator and a platform admin (the rule posts follow, and the post's
 *   author has NO privilege of revelation). The row says whether the writer is the post's own
 *   author (`byPostAuthor`), and only on a personal post: an association post hides its author
 *   even from admins, so the answer there would name them.
 * - `associationId` - the comment belongs to the association, not to its writer: `userId` is
 *   withheld the same way, the association card is served, and EVERY holder of `POST_AS_ASSO`
 *   may edit or delete it; a platform admin may delete it, never edit it (owner, 2026-11-02).
 *
 * Withholding `userId` breaks the client's `userId === currentUserId` control checks, so the
 * server serves `canEdit` and `canDelete` PER READER and the client derives nothing from `userId`.
 * The fields are only ever ADDED: an older client still draws its own controls from `userId`.
 */

/** What decides a reader's view of a comment. */
export interface CommentViewer {
  viewerId?: string;
  isGlobalAdmin: boolean;
  /**
   * The reader moderates the POST these comments sit under (a BDE `MODERATE` holder whose governed
   * spaces hold it, owner 2026-11-02): a comment is judged where it is shown.
   */
  isModerator: boolean;
  /**
   * Associations in which the reader REALLY holds `POST_AS_ASSO` - for a platform admin too, their
   * own memberships and not the admin tier: holding it is what makes them the comment's author.
   */
  managedAssociationIds: ReadonlySet<string>;
  /**
   * Associations whose PUBLISHED content the reader moderates as a BDE (lowercase ids,
   * `AssociationsService.moderatedAssociationIds`): never an institution, never another BDE (owner,
   * 2026-11-03). A comment in an association's name is that association's content, so moderating
   * the post it sits under is not enough. Unread for a platform admin, who moderates everything.
   */
  moderatedAssociationIds: ReadonlySet<string>;
}

/** The facts about the post a comment sits under. */
export interface CommentPostFacts {
  /** Its id: what the moderator scope of its comments is asked of. */
  id?: string;
  authorId?: string | null;
  associationId?: string | null;
}

export interface AssociationCard {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
}

interface StoredComment {
  id?: string;
  /** The comment this one replies to: deleting that one takes this one with it. */
  parentId?: string | null;
  userId?: string | null;
  anonymous?: boolean;
  associationId?: string | null;
  [key: string]: unknown;
}

/** The associations these comments speak for. */
function associationIdsOf(comments: readonly StoredComment[]): string[] {
  return comments.map((c) => c.associationId).filter((id): id is string => !!id);
}

/** The direct replies of each comment of `list`, by the id of the comment they reply to. */
export function repliesByParent(list: readonly StoredComment[]): Map<string, StoredComment[]> {
  const out = new Map<string, StoredComment[]>();
  for (const c of list) {
    if (!c.parentId) continue;
    const held = out.get(c.parentId);
    if (held) held.push(c);
    else out.set(c.parentId, [c]);
  }
  return out;
}

/** True for a comment that is not the writer's own name on it - exempt from the block filter. */
export function isMaskedComment(c: {
  anonymous?: boolean;
  associationId?: string | null;
}): boolean {
  return c.anonymous === true || !!c.associationId;
}

/** The reader moderates what comment `c` is published as: a person's always, an association's per the set. */
function moderatesPublisher(c: StoredComment, v: CommentViewer): boolean {
  return !c.associationId || v.moderatedAssociationIds.has(c.associationId.toLowerCase());
}

/**
 * May reader `v` moderate (delete) comment `c`, whose direct replies are `replies`? The in-memory
 * twin of `bdeModeratesCommentSql` (`spaces/bde-moderation.ts`), on the same publisher set: a
 * platform admin always; a BDE moderator when it moderates the post (`isModerator`), the comment's
 * publisher AND every reply's - a delete takes the replies, so an institution's or another BDE's
 * reply is never deleted through its parent (owner, 2026-11-03).
 */
export function moderatesCommentThread(
  c: StoredComment,
  replies: readonly StoredComment[],
  v: CommentViewer
): boolean {
  if (v.isGlobalAdmin) return true;
  return (
    v.isModerator && moderatesPublisher(c, v) && replies.every((r) => moderatesPublisher(r, v))
  );
}

/**
 * The ONE statement of who may edit and delete a comment. It serves the controls AND enforces the
 * write, so the button a reader is shown and the refusal they would get cannot disagree. `replies`
 * are the comment's direct replies the caller holds - the WHOLE thread on a write, which reads the
 * stored post; a feed window may hold fewer, and the write then decides on the stored thread.
 */
export function commentRights(
  c: StoredComment,
  v: CommentViewer,
  replies: readonly StoredComment[] = []
): { canEdit: boolean; canDelete: boolean } {
  // A comment's integrity, as a post's (owner, 2026-11-02): only its author changes its text. The
  // association is the author of its comment, so its POST_AS_ASSO holders edit it.
  const author = c.associationId
    ? v.managedAssociationIds.has(c.associationId)
    : !!v.viewerId && c.userId === v.viewerId;
  // MODERATE deletes within its scope (owner, 2026-11-02, 2026-11-03): a platform admin anything; a
  // BDE moderator of THIS post a comment whose publisher (and replies' publishers) it moderates -
  // never an institution's or another BDE's - and never rewrites one. The same answer
  // `POST /moderation/comments/:id/delete` gives, so the bin and the route agree.
  return { canEdit: author, canDelete: author || moderatesCommentThread(c, replies, v) };
}

/** Whether this reader may see the real account behind a masked comment. */
function seesAccount(c: StoredComment, v: CommentViewer): boolean {
  // Reading who wrote an association's comment is moderating that association's content.
  if (v.isGlobalAdmin || (v.isModerator && moderatesPublisher(c, v))) return true;
  // The association's comment is not its writer's own, so the writer is not special there.
  return c.anonymous === true && !c.associationId && !!v.viewerId && c.userId === v.viewerId;
}

/** One comment as `v` may see it: identity withheld where it must be, the controls attached. */
export function serveComment<T extends StoredComment>(
  c: T,
  v: CommentViewer,
  post: CommentPostFacts,
  cards: ReadonlyMap<string, AssociationCard>,
  replies: readonly StoredComment[] = []
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...c, ...commentRights(c, v, replies) };
  delete out.associationId;
  if (c.associationId) {
    out.association = cards.get(c.associationId) ?? null;
  }
  if (isMaskedComment(c) && !seesAccount(c, v)) {
    delete out.userId;
  }
  if (c.anonymous === true) {
    delete out.displayName;
    delete out.firstName;
    delete out.lastName;
    if (!post.associationId) {
      out.byPostAuthor = !!post.authorId && c.userId === post.authorId;
    }
  }
  return out;
}

/** Reads `anonymous`/`associationId` from the request into the stored pair; exclusive, like a post's. */
export function commentIdentityOf(data: { anonymous?: boolean; associationId?: string }): {
  anonymous: boolean;
  associationId: string | null;
} {
  const associationId = data.associationId || null;
  return { associationId, anonymous: !!data.anonymous && !associationId };
}

/** Resolves a reader's standing and the association cards, then serves comments through `serveComment`. */
@Injectable()
export class CommentIdentityService {
  private readonly logger = new Logger(CommentIdentityService.name);

  constructor(
    private readonly associations: AssociationsService,
    @InjectRepository(Post) private readonly postRepo: Repository<Post>
  ) {}

  /** The typed moderation refusal (`AssociationsService.refuseModeration`), for a comment's write path. */
  refuseModeration(userId: string, target: ModerationTarget): Promise<never> {
    return this.associations.refuseModeration(userId, target);
  }

  /** Everyone who speaks for the association: who a reply to its comment must notify. */
  holdersOf(associationId: string): Promise<string[]> {
    return this.associations.listFlagHolders(associationId, AssociationPermissionFlag.POST_AS_ASSO);
  }

  /**
   * The reader's standing over these comments, all under post `who.postId`; `isModerator` is taken
   * when the caller knows it, and otherwise asked of THAT post (`mayModeratePost`) - never "does the
   * reader moderate somewhere", which is the door and not the reach.
   */
  async viewerFor(
    comments: StoredComment[],
    who: { viewerId?: string; isGlobalAdmin?: boolean; isModerator?: boolean; postId?: string }
  ): Promise<CommentViewer> {
    const isGlobalAdmin = who.isGlobalAdmin === true;
    const assocIds = associationIdsOf(comments);
    const [isModerator, managedAssociationIds] = await Promise.all([
      // A platform admin moderates everywhere: nothing to ask of the post.
      who.isModerator !== undefined
        ? Promise.resolve(who.isModerator)
        : !isGlobalAdmin && who.viewerId && who.postId
          ? this.associations.mayModeratePost(who.viewerId, who.postId, { isGlobalAdmin })
          : Promise.resolve(isGlobalAdmin),
      // No admin tier: the pencil is the author's alone (owner, 2026-11-02).
      this.associations.mayActOnAny(who.viewerId, assocIds, AssociationPermissionFlag.POST_AS_ASSO),
    ]);
    const moderatedAssociationIds = await this.moderatedPublishers(
      who.viewerId,
      isModerator && !isGlobalAdmin,
      assocIds
    );
    return {
      viewerId: who.viewerId,
      isGlobalAdmin,
      isModerator,
      managedAssociationIds,
      moderatedAssociationIds,
    };
  }

  /**
   * The publishers among `assocIds` a BDE moderator moderates - asked ONLY of a reader who moderates
   * the post as a BDE and only when an association's comment is there: everyone else (an ordinary
   * reader, the platform admin, who moderates everything) never pays the query.
   */
  private async moderatedPublishers(
    viewerId: string | undefined,
    bdeModerator: boolean,
    assocIds: string[]
  ): Promise<ReadonlySet<string>> {
    if (!bdeModerator || !viewerId || assocIds.length === 0) return new Set();
    return this.associations.moderatedAssociationIds(viewerId, assocIds);
  }

  private async cardsFor(comments: StoredComment[]): Promise<Map<string, AssociationCard>> {
    const ids = [
      ...new Set(comments.map((c) => c.associationId).filter((id): id is string => !!id)),
    ];
    if (ids.length === 0) return new Map();
    const rows: AssociationCard[] = await this.postRepo.manager.query(
      `SELECT id, name, slug, "logoUrl" FROM associations WHERE id = ANY($1::uuid[])`,
      [ids]
    );
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** `comments` of one post, served to one reader. */
  async serve(
    comments: StoredComment[] | null | undefined,
    post: CommentPostFacts,
    who: { viewerId?: string; isGlobalAdmin?: boolean; isModerator?: boolean }
  ): Promise<Record<string, unknown>[]> {
    const list = comments ?? [];
    if (list.length === 0) return [];
    const [viewer, cards] = await Promise.all([
      this.viewerFor(list, { ...who, postId: post.id }),
      this.cardsFor(list),
    ]);
    const replies = repliesByParent(list);
    return list.map((c) => serveComment(c, viewer, post, cards, replies.get(c.id ?? '')));
  }

  /**
   * Serves the comment window of every row of a page, in place, in ONE standing query and ONE card
   * query for the whole page. Rows are RAW (they still carry `authorId`, which `byPostAuthor`
   * needs and the post's own shaping will withhold), so this runs BEFORE that shaping.
   */
  async serveRows(
    rows: Array<{
      id?: string;
      comments?: unknown;
      authorId?: string | null;
      associationId?: string | null;
    }>,
    who: { viewerId?: string; isGlobalAdmin?: boolean; moderatedPostIds: ReadonlySet<string> }
  ): Promise<void> {
    const all = rows.flatMap((r) =>
      Array.isArray(r.comments) ? (r.comments as StoredComment[]) : []
    );
    if (all.length === 0) return;
    // The standing is read once for the page; the moderator half is per ROW, each post's own scope,
    // and the publishers it moderates are read once too - only when it moderates some row at all.
    const [base, cards, moderatedAssociationIds] = await Promise.all([
      this.viewerFor(all, {
        viewerId: who.viewerId,
        isGlobalAdmin: who.isGlobalAdmin,
        isModerator: false,
      }),
      this.cardsFor(all),
      this.moderatedPublishers(
        who.viewerId,
        who.isGlobalAdmin !== true && who.moderatedPostIds.size > 0,
        associationIdsOf(all)
      ),
    ]);
    for (const row of rows) {
      if (!Array.isArray(row.comments)) continue;
      const viewer: CommentViewer = {
        ...base,
        isModerator: !!row.id && who.moderatedPostIds.has(row.id),
        moderatedAssociationIds,
      };
      const list = row.comments as StoredComment[];
      const replies = repliesByParent(list);
      row.comments = list.map((c) => serveComment(c, viewer, row, cards, replies.get(c.id ?? '')));
    }
    this.logger.debug(`serveRows: ${all.length} comments over ${rows.length} rows`);
  }
}
