import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AssociationsService } from '../associations/associations.service';
import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';
import { Post } from './entities/post.entity';

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
 *   (or a platform admin) may edit or delete it.
 *
 * Withholding `userId` breaks the client's `userId === currentUserId` control checks, so the
 * server serves `canEdit` and `canDelete` PER READER and the client derives nothing from `userId`.
 * The fields are only ever ADDED: an older client still draws its own controls from `userId`.
 */

/** What decides a reader's view of a comment. */
export interface CommentViewer {
  viewerId?: string;
  isGlobalAdmin: boolean;
  isModerator: boolean;
  /** Associations in which the reader holds `POST_AS_ASSO` (a platform admin: all of them). */
  managedAssociationIds: ReadonlySet<string>;
}

/** The facts about the post a comment sits under. */
export interface CommentPostFacts {
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
  userId?: string | null;
  anonymous?: boolean;
  associationId?: string | null;
  [key: string]: unknown;
}

/** True for a comment that is not the writer's own name on it - exempt from the block filter. */
export function isMaskedComment(c: {
  anonymous?: boolean;
  associationId?: string | null;
}): boolean {
  return c.anonymous === true || !!c.associationId;
}

/**
 * The ONE statement of who may edit and delete a comment. It serves the controls AND enforces the
 * write, so the button a reader is shown and the refusal they would get cannot disagree.
 */
export function commentRights(
  c: StoredComment,
  v: CommentViewer
): { canEdit: boolean; canDelete: boolean } {
  const own = !!v.viewerId && c.userId === v.viewerId;
  if (c.associationId) {
    const mayAct = v.isGlobalAdmin || v.managedAssociationIds.has(c.associationId);
    return { canEdit: mayAct, canDelete: mayAct };
  }
  if (c.anonymous === true) {
    return { canEdit: own, canDelete: own || v.isGlobalAdmin || v.isModerator };
  }
  return { canEdit: own, canDelete: own || v.isGlobalAdmin };
}

/** Whether this reader may see the real account behind a masked comment. */
function seesAccount(c: StoredComment, v: CommentViewer): boolean {
  if (v.isGlobalAdmin || v.isModerator) return true;
  // The association's comment is not its writer's own, so the writer is not special there.
  return c.anonymous === true && !c.associationId && !!v.viewerId && c.userId === v.viewerId;
}

/** One comment as `v` may see it: identity withheld where it must be, the controls attached. */
export function serveComment<T extends StoredComment>(
  c: T,
  v: CommentViewer,
  post: CommentPostFacts,
  cards: ReadonlyMap<string, AssociationCard>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...c, ...commentRights(c, v) };
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

  /** Everyone who speaks for the association: who a reply to its comment must notify. */
  holdersOf(associationId: string): Promise<string[]> {
    return this.associations.listFlagHolders(associationId, AssociationPermissionFlag.POST_AS_ASSO);
  }

  /** The reader's standing over these comments; `isModerator` is taken when the caller knows it. */
  async viewerFor(
    comments: StoredComment[],
    who: { viewerId?: string; isGlobalAdmin?: boolean; isModerator?: boolean }
  ): Promise<CommentViewer> {
    const isGlobalAdmin = who.isGlobalAdmin === true;
    const assocIds = comments.map((c) => c.associationId).filter((id): id is string => !!id);
    const [isModerator, managedAssociationIds] = await Promise.all([
      who.isModerator !== undefined
        ? Promise.resolve(who.isModerator)
        : who.viewerId
          ? this.associations.isContentModerator(who.viewerId, { isGlobalAdmin })
          : Promise.resolve(isGlobalAdmin),
      this.associations.mayActOnAny(
        who.viewerId,
        assocIds,
        AssociationPermissionFlag.POST_AS_ASSO,
        { isGlobalAdmin }
      ),
    ]);
    return { viewerId: who.viewerId, isGlobalAdmin, isModerator, managedAssociationIds };
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
    const [viewer, cards] = await Promise.all([this.viewerFor(list, who), this.cardsFor(list)]);
    return list.map((c) => serveComment(c, viewer, post, cards));
  }

  /**
   * Serves the comment window of every row of a page, in place, in ONE standing query and ONE card
   * query for the whole page. Rows are RAW (they still carry `authorId`, which `byPostAuthor`
   * needs and the post's own shaping will withhold), so this runs BEFORE that shaping.
   */
  async serveRows(
    rows: Array<{ comments?: unknown; authorId?: string | null; associationId?: string | null }>,
    who: { viewerId?: string; isGlobalAdmin?: boolean; isModerator?: boolean }
  ): Promise<void> {
    const all = rows.flatMap((r) =>
      Array.isArray(r.comments) ? (r.comments as StoredComment[]) : []
    );
    if (all.length === 0) return;
    const [viewer, cards] = await Promise.all([this.viewerFor(all, who), this.cardsFor(all)]);
    for (const row of rows) {
      if (!Array.isArray(row.comments)) continue;
      row.comments = (row.comments as StoredComment[]).map((c) =>
        serveComment(c, viewer, row, cards)
      );
    }
    this.logger.debug(`serveRows: ${all.length} comments over ${rows.length} rows`);
  }
}
