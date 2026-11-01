import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, type EntityManager } from 'typeorm';
import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';
import { isBlockedBetween } from '../common/user-blocks';
import { DELETED_ACCOUNT } from '../internal/account-erasure';
import { ModerationService } from '../moderation/moderation.service';
import {
  ProposalsService,
  type AfterCommit,
  type UserProposal,
  type UserProposalKindHandler,
  type UserProposalView,
} from '../proposals/proposals.service';
import { previewOf } from '../push/push-content';
import { REPUBLICATION_REQUESTS_TARGET } from '../push/push-target';
import {
  newlyReachedByPersonalRepublicationSql,
  postVisibleToViewerSql,
} from '../spaces/reader-spaces';
import { PostRepublication } from './entities/post-republication.entity';
import { PostNotificationsService } from './post-notifications.service';
import { lockPostRow, PERSONAL_REPUBLISHING_ASSOCIATION_TYPES } from './republication-sql';
import { RepublicationsService, isWithheldPost } from './republications.service';

/**
 * At most this many requests may wait for ONE author's answer at once (D38b): an inbox a few
 * associations could fill is a channel for spam. Counted on state - pending rows - under a lock,
 * never on a clock: a refusal or an acceptance frees a seat at once.
 */
export const MAX_PENDING_REQUESTS_PER_AUTHOR = 20;

/**
 * At most this many requests one association may have waiting at once (D38b) - the per-association
 * brake against spam, on state rather than on a time window (see the durable rule "idempotence
 * comes from durable state, never from a clock"): an association that wants to ask more must wait
 * for answers. A refusal stands; a request the association WITHDRAWS frees its pair to be asked
 * again, but only the first ask of a pair is ever announced (`ProposalsService.proposeToUser`), so a
 * withdraw-and-ask loop puts nothing new in the author's bell or on their phone.
 */
export const MAX_PENDING_REQUESTS_PER_ASSOCIATION = 10;

/**
 * The stable codes a refusal carries, which the client maps to its own sentence - never the
 * message, which is developer prose.
 */
export const PERSONAL_REPOST_CODES = {
  /** The post speaks for an association: D38's routes apply, not a request to a person. */
  notPersonal: 'REPOST_PERSONAL_NOT_PERSONAL',
  /** An anonymous post: republishing it under an association would tie it back to its author. */
  anonymous: 'REPOST_PERSONAL_ANONYMOUS',
  /** The proposer wrote the post: they would be asking themselves. */
  ownPost: 'REPOST_PERSONAL_OWN_POST',
  /** The proposing association is not of a kind that may ask (a list, an institution, archived). */
  associationType: 'REPOST_PERSONAL_ASSOCIATION_TYPE',
  /** A block stands between the proposer and the author, in either direction. */
  blocked: 'REPOST_PERSONAL_BLOCKED',
  /** The association already republishes this post. */
  alreadyRepublished: 'REPOST_PERSONAL_ALREADY_REPUBLISHED',
  /** The author already has `MAX_PENDING_REQUESTS_PER_AUTHOR` requests waiting. */
  authorCap: 'REPOST_PERSONAL_AUTHOR_CAP',
  /** The association already has `MAX_PENDING_REQUESTS_PER_ASSOCIATION` requests waiting. */
  associationCap: 'REPOST_PERSONAL_ASSOCIATION_CAP',
  /** The author's account is restricted (muted): accepting would widen what they published. */
  authorMuted: 'REPOST_PERSONAL_AUTHOR_MUTED',
} as const;

/** The proposing association, as a request needs it. */
interface ProposerAssociationRow {
  id: string;
  name: string;
  type: string;
  archived: boolean;
  logoUrl: string | null;
  logoMediaId: string | null;
}

/**
 * A PERSONAL POST REPUBLISHED BY AN ASSOCIATION, WITH ITS AUTHOR'S CONSENT (D38b, decided by the
 * user on 2026-10-19: "J'aimerais bien qu'on puisse republier en tant qu'association le post d'une
 * personne").
 *
 * The `repost-personal` kind of the generic proposals (migration 096): whoever may publish in an
 * association's name (`POST_AS_ASSO`, held) ASKS; the post's AUTHOR - and only them - accepts or
 * refuses. Nothing is visible before the yes: the acceptance writes the very `post_republications`
 * row D38 writes (`RepublicationsService.writeRepublication`, in the decision's transaction), after
 * which the reader predicate, the card's "Republie par" line and the first-time notification work
 * unchanged. The author may withdraw it at any time, and the association its own.
 *
 * WHAT IS REFUSED, each for a reason a test names: a post the proposer cannot see (404, before
 * anything about it is confirmed); an association post (D38's routes); an ANONYMOUS post (an
 * association's name beside it would tie it back to its author, and the request itself would tell
 * the proposer whose it is - so it is refused before anything is written); the proposer's own post;
 * a hidden, scheduled or expired one (404); a block either way between proposer and author; a muted
 * proposer (the controller); an association that already carries it; a second request (409, and a
 * refusal stands); and the two caps above.
 */
@Injectable()
export class PersonalRepublicationsService implements OnModuleInit, UserProposalKindHandler {
  private readonly logger = new Logger(PersonalRepublicationsService.name);
  readonly kind = 'repost-personal' as const;
  readonly target = 'user' as const;
  readonly senderFlag = AssociationPermissionFlag.POST_AS_ASSO;

  constructor(
    @InjectRepository(PostRepublication) private readonly repo: Repository<PostRepublication>,
    private readonly republications: RepublicationsService,
    private readonly notifications: PostNotificationsService,
    private readonly moderation: ModerationService,
    private readonly proposals: ProposalsService
  ) {}

  onModuleInit(): void {
    this.proposals.register(this);
  }

  /** `actorId` asks, in `associationId`'s name, the author of `postId` to let it republish the post. */
  request(postId: string, associationId: string, actorId: string) {
    return this.proposals.proposeToUser(this.kind, postId, associationId, actorId);
  }

  /** The requests waiting for `userId`'s answer - their own inbox. */
  inbox(userId: string): Promise<{ incoming: UserProposalView[] }> {
    return this.proposals.listForUser(userId);
  }

  /** How many requests wait for `userId`'s answer - one count, for the way to the inbox. */
  async pendingCount(userId: string): Promise<{ pending: number }> {
    return { pending: await this.proposals.countForUser(userId) };
  }

  // ── The `repost-personal` proposal kind ────────────────────────────────────────────────────────

  async resolveRecipient(
    manager: EntityManager,
    postId: string,
    fromAssociationId: string,
    actorId: string
  ): Promise<string> {
    const post = await this.republications.loadPostRow(postId, manager);
    if (!post || isWithheldPost(post)) {
      this.logger.debug(`[REPOST-P] ${postId.slice(0, 8)} refused: absent or withheld`);
      throw new NotFoundException('Post not found');
    }
    // Seen FIRST, so nothing below confirms a post the proposer cannot see - not even that it is
    // anonymous. Grant-free and without the admin's by-id reach: the proposer reads it in their feed.
    await this.assertVisibleWithoutGrant(manager, postId, actorId);
    if (post.associationId) {
      throw refusal(BadRequestException, PERSONAL_REPOST_CODES.notPersonal, 'Not a personal post');
    }
    if (post.anonymous) {
      this.logger.debug(`[REPOST-P] ${postId.slice(0, 8)} refused: anonymous`);
      throw refusal(BadRequestException, PERSONAL_REPOST_CODES.anonymous, 'An anonymous post');
    }
    if (post.authorId === actorId) {
      throw refusal(BadRequestException, PERSONAL_REPOST_CODES.ownPost, 'Your own post');
    }
    await this.assertProposingAssociation(manager, fromAssociationId);
    if (await isBlockedBetween(manager, actorId, post.authorId)) {
      this.logger.debug(`[REPOST-P] ${postId.slice(0, 8)} refused: a block with its author`);
      throw refusal(ForbiddenException, PERSONAL_REPOST_CODES.blocked, 'A block stands');
    }
    const carried: unknown[] = await manager.query(
      `SELECT 1 FROM post_republications WHERE "postId" = $1 AND "associationId" = $2`,
      [postId, fromAssociationId]
    );
    if (carried.length > 0) {
      throw refusal(
        ConflictException,
        PERSONAL_REPOST_CODES.alreadyRepublished,
        'This association already republishes this post'
      );
    }
    await this.assertWithinCaps(manager, post.authorId, fromAssociationId);
    return post.authorId;
  }

  async apply(
    manager: EntityManager,
    proposal: UserProposal,
    actorId: string
  ): Promise<AfterCommit> {
    // Judged again, NOW: the post may have been hidden, or its author restricted, since the ask.
    const post = await this.republications.loadPostRow(proposal.subjectId, manager);
    if (!post || isWithheldPost(post)) throw new NotFoundException('Post not found');
    if (post.associationId) {
      throw refusal(BadRequestException, PERSONAL_REPOST_CODES.notPersonal, 'Not a personal post');
    }
    if (post.anonymous) {
      throw refusal(BadRequestException, PERSONAL_REPOST_CODES.anonymous, 'An anonymous post');
    }
    if (await this.moderation.isUserMuted(actorId)) {
      this.logger.debug(`[REPOST-P] ${proposal.id.slice(0, 8)} refused: its author is muted`);
      throw refusal(ForbiddenException, PERSONAL_REPOST_CODES.authorMuted, 'Account restricted');
    }
    await this.assertProposingAssociation(manager, proposal.fromAssociationId);
    // The republication is IN THE ASSOCIATION'S NAME, and the member who asked is who republished:
    // the author consented, they did not speak for the association.
    const written = await this.republications.writeRepublication(
      manager,
      post,
      proposal.fromAssociationId,
      proposal.proposedBy
    );
    this.logger.log(
      `[REPOST-P] ${post.id.slice(0, 8)} republished by ${proposal.fromAssociationId.slice(0, 8)} ` +
        `with its author's consent (newly reached ${written.newlyReached})`
    );
    return written.after;
  }

  async announce(proposal: UserProposal): Promise<void> {
    const [from, post] = await Promise.all([
      this.loadAssociation(this.repo.manager, proposal.fromAssociationId),
      this.republications.loadPostRow(proposal.subjectId),
    ]);
    if (!from || !post) {
      this.logger.warn(
        `[REPOST-P] request ${proposal.id} cannot be announced: its association or post is gone`
      );
      return;
    }
    const count = await this.notifications.createNotifications({
      recipientIds: [proposal.toUserId],
      type: 'repost_personal_requested',
      postId: post.id,
      actorId: proposal.proposedBy,
      actorName: from.name,
      associationId: from.id,
      associationLogoUrl: from.logoUrl,
      associationLogoMediaId: from.logoMediaId,
      text: previewOf(post.markdown ?? ''),
      // The tap opens the author's own requests, where the answer is given.
      pushData: { target: REPUBLICATION_REQUESTS_TARGET },
    });
    this.logger.log(`[REPOST-P] request ${proposal.id.slice(0, 8)} announced to ${count}`);
  }

  async decided(proposal: UserProposal): Promise<void> {
    if (proposal.proposedBy === DELETED_ACCOUNT) {
      this.logger.debug(`[REPOST-P] ${proposal.id.slice(0, 8)} decided: its proposer is erased`);
      return;
    }
    const [from, post] = await Promise.all([
      this.loadAssociation(this.repo.manager, proposal.fromAssociationId),
      this.republications.loadPostRow(proposal.subjectId),
    ]);
    if (!from || !post) {
      this.logger.warn(`[REPOST-P] ${proposal.id} decided but its association or post is gone`);
      return;
    }
    // In-app only: the answer is not urgent, and a push per answer would be a sentence on every
    // phone for something the proposer can read on their next visit.
    const count = await this.notifications.createNotifications({
      recipientIds: [proposal.proposedBy],
      type: proposal.status === 'accepted' ? 'repost_personal_accepted' : 'repost_personal_refused',
      postId: post.id,
      actorId: proposal.toUserId,
      associationId: from.id,
      associationLogoUrl: from.logoUrl,
      associationLogoMediaId: from.logoMediaId,
      text: previewOf(post.markdown ?? ''),
      skipPush: true,
    });
    this.logger.log(
      `[REPOST-P] ${proposal.id.slice(0, 8)} ${proposal.status}: proposer told (${count})`
    );
  }

  /**
   * The sending association's queue: the posts `viewerId` sees WITHOUT a grant and without the
   * administrator's by-id reach - the very predicate the request itself passed. A member of the
   * association who cannot see a post learns nothing of it here, not even that it exists.
   */
  async describe(
    postIds: string[],
    viewerId: string
  ): Promise<Map<string, Record<string, unknown>>> {
    if (postIds.length === 0) return new Map();
    const rows: SubjectRow[] = await this.repo.manager.query(
      `SELECT posts.id, posts.markdown, posts."publishedAt" AS "createdAt", posts."feedNotifiedAt"
         FROM posts
        WHERE posts.id = ANY($1::uuid[])
          AND ${postVisibleToViewerSql('posts', '$2', { adminSeesAll: false, readGrants: false, memberReposts: false })}`,
      [postIds, viewerId]
    );
    const hidden = postIds.length - rows.length;
    if (hidden > 0) {
      this.logger.debug(`[REPOST-P] queue of ${viewerId.slice(0, 8)}: ${hidden} subject(s) unseen`);
    }
    return new Map(rows.map((r) => [r.id, subjectView(r)]));
  }

  /**
   * What the author sees before answering (D38b): the post, and HOW MANY readers acceptance would
   * tell it reached - `newlyReachedByPersonalRepublicationSql`, the very query `writeRepublication`
   * runs, with the post's own announce state: the association's readers who cannot see it now,
   * minus anyone in a block with the author, and - before the post's first announcement - minus the
   * followers the sweep tells anyway. A count, never names.
   */
  async describeRequests(proposals: UserProposal[]): Promise<Map<string, Record<string, unknown>>> {
    const out = new Map<string, Record<string, unknown>>();
    const ids = [...new Set(proposals.map((p) => p.subjectId))];
    // The author's own posts: no visibility filter, they are its author.
    const rows: SubjectRow[] = ids.length
      ? await this.repo.manager.query(
          `SELECT id, markdown, "publishedAt" AS "createdAt", "feedNotifiedAt"
             FROM posts WHERE id = ANY($1::uuid[])`,
          [ids]
        )
      : [];
    const subjects = new Map(rows.map((r) => [r.id, r]));
    for (const proposal of proposals) {
      const subject = subjects.get(proposal.subjectId);
      if (!subject) continue;
      const reached: { n: number }[] = await this.repo.manager.query(
        `SELECT count(*)::int AS n
           FROM (${newlyReachedByPersonalRepublicationSql(subject.feedNotifiedAt !== null)}) nr`,
        [proposal.subjectId, proposal.fromAssociationId]
      );
      out.set(proposal.id, { ...subjectView(subject), newlyReached: reached[0]?.n ?? 0 });
    }
    return out;
  }

  /** The post first, then the proposal: see `lockPostRow`. */
  lockSubject(manager: EntityManager, postId: string): Promise<void> {
    return lockPostRow(manager, postId);
  }

  /**
   * The asker still holds `POST_AS_ASSO` in the association - read from the membership row itself,
   * which is exact because that flag is never granted by a BDE tier - and is not restricted
   * (`user_moderation.isMuted`, what `ModerationService.isUserMuted` reads). An erased asker has no
   * membership left, so it no longer speaks either. The flag is a constant of this class, never input.
   */
  senderSpeaksSql(alias: string): string {
    return `(EXISTS (SELECT 1 FROM association_members am
                      WHERE am."associationId" = ${alias}."fromAssociationId"
                        AND am."userId" = ${alias}."proposedBy"
                        AND (am.permissions & ${Number(this.senderFlag)}) <> 0)
             AND NOT EXISTS (SELECT 1 FROM user_moderation um
                              WHERE um."userId" = ${alias}."proposedBy" AND um."isMuted" = true))`;
  }

  /** `senderSpeaksSql`, for one request, inside the acceptance's transaction. */
  async senderStillSpeaks(manager: EntityManager, proposal: UserProposal): Promise<boolean> {
    const rows: { speaks: boolean }[] = await manager.query(
      `SELECT ${this.senderSpeaksSql('p')} AS speaks FROM proposals p WHERE p.id = $1`,
      [proposal.id]
    );
    const speaks = rows[0]?.speaks === true;
    if (!speaks) {
      this.logger.debug(
        `[REPOST-P] ${proposal.id.slice(0, 8)}: its asker lost the flag, left or is muted`
      );
    }
    return speaks;
  }

  /** A request taken back leaves nothing to answer: its bell row goes in the same transaction. */
  async withdrawn(manager: EntityManager, proposal: UserProposal): Promise<void> {
    const result: unknown = await manager.query(
      `DELETE FROM post_notifications
        WHERE "recipientId" = $1 AND type = 'repost_personal_requested'
          AND "postId" = $2 AND "associationId" = $3`,
      [proposal.toUserId, proposal.subjectId, proposal.fromAssociationId]
    );
    const removed = Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
    this.logger.debug(
      `[REPOST-P] ${proposal.id.slice(0, 8)} withdrawn: ${removed} bell row(s) removed`
    );
  }

  // ── Reads and refusals ─────────────────────────────────────────────────────────────────────────

  private async assertVisibleWithoutGrant(
    manager: EntityManager,
    postId: string,
    actorId: string
  ): Promise<void> {
    const rows: { visible: boolean }[] = await manager.query(
      `SELECT ${postVisibleToViewerSql('posts', '$2', { adminSeesAll: false, readGrants: false, memberReposts: false })} AS visible
         FROM posts WHERE posts.id = $1`,
      [postId, actorId]
    );
    if (rows[0]?.visible !== true) {
      this.logger.debug(`[REPOST-P] ${postId.slice(0, 8)} not visible to ${actorId.slice(0, 8)}`);
      throw new NotFoundException('Post not found');
    }
  }

  private async loadAssociation(
    manager: EntityManager,
    id: string
  ): Promise<ProposerAssociationRow | null> {
    const rows: ProposerAssociationRow[] = await manager.query(
      `SELECT id, name, type, COALESCE(archived, false) AS archived, "logoUrl", "logoMediaId"
         FROM associations WHERE id = $1`,
      [id]
    );
    return rows[0] ?? null;
  }

  /** The proposing association exists, is of a kind that may ask, and still speaks (not archived). */
  private async assertProposingAssociation(manager: EntityManager, id: string): Promise<void> {
    const association = await this.loadAssociation(manager, id);
    if (!association) throw new NotFoundException('Association not found');
    if (
      !PERSONAL_REPUBLISHING_ASSOCIATION_TYPES.includes(association.type) ||
      association.archived
    ) {
      this.logger.debug(
        `[REPOST-P] ${id.slice(0, 8)} may not ask: type ${association.type}, archived=${association.archived}`
      );
      throw refusal(
        BadRequestException,
        PERSONAL_REPOST_CODES.associationType,
        'This association may not republish a personal post'
      );
    }
  }

  /**
   * The two caps, counted under TWO transaction-scoped advisory locks - the author's, then the
   * association's, always in that order, so two requests cannot both read "one seat left" and both
   * take it, and no two transactions wait on each other in a cycle. A request whose asker no longer
   * speaks (`senderSpeaksSql`) holds no seat: the author never sees it, and it can only be voided.
   */
  private async assertWithinCaps(
    manager: EntityManager,
    authorId: string,
    associationId: string
  ): Promise<void> {
    await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `repost-personal:user:${authorId}`,
    ]);
    await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `repost-personal:association:${associationId}`,
    ]);
    const counts: { toAuthor: number; fromAssociation: number }[] = await manager.query(
      `SELECT count(*) FILTER (WHERE "toUserId" = $1)::int AS "toAuthor",
              count(*) FILTER (WHERE "fromAssociationId" = $2)::int AS "fromAssociation"
         FROM proposals p
        WHERE p.kind = 'repost-personal' AND p.status = 'pending'
          AND (p."toUserId" = $1 OR p."fromAssociationId" = $2)
          AND ${this.senderSpeaksSql('p')}`,
      [authorId, associationId]
    );
    const { toAuthor, fromAssociation } = counts[0] ?? { toAuthor: 0, fromAssociation: 0 };
    if (toAuthor >= MAX_PENDING_REQUESTS_PER_AUTHOR) {
      this.logger.log(`[REPOST-P] author ${authorId.slice(0, 8)} has ${toAuthor} waiting: refused`);
      throw refusal(
        ConflictException,
        PERSONAL_REPOST_CODES.authorCap,
        'Too many waiting requests'
      );
    }
    if (fromAssociation >= MAX_PENDING_REQUESTS_PER_ASSOCIATION) {
      this.logger.log(
        `[REPOST-P] association ${associationId.slice(0, 8)} has ${fromAssociation} waiting: refused`
      );
      throw refusal(
        ConflictException,
        PERSONAL_REPOST_CODES.associationCap,
        'Too many requests waiting for this association'
      );
    }
  }
}

/** A post as a request's description needs it. */
interface SubjectRow {
  id: string;
  markdown: string | null;
  createdAt: Date;
  feedNotifiedAt: Date | null;
}

/** What a queue or an inbox shows about the post: its opening and its date. */
function subjectView(row: SubjectRow): Record<string, unknown> {
  return { preview: previewOf(row.markdown ?? ''), createdAt: row.createdAt };
}

/** An HTTP refusal carrying a stable `code` - the client maps the code, never the message. */
function refusal(
  Kind: typeof BadRequestException | typeof ConflictException | typeof ForbiddenException,
  code: string,
  message: string
) {
  return new Kind({ code, message });
}
