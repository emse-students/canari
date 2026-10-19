import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, type EntityManager } from 'typeorm';
import { AssociationsService } from '../associations/associations.service';
import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';
import { isUniqueViolation } from '../common/pg-errors';
import { formatUserDisplayNameFromRaw } from '../utils/user-display-name';
import {
  Proposal,
  PROPOSAL_VOIDED_BY,
  type ProposalKind,
  type ProposalStatus,
} from './proposal.entity';

/** The first row of an `UPDATE ... RETURNING`, which node-postgres answers as [rows, count] via TypeORM. */
function firstReturned(result: unknown): Proposal | null {
  const rows = Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result;
  return Array.isArray(rows) ? ((rows[0] as Proposal | undefined) ?? null) : null;
}

/**
 * The refusal code of an acceptance that found the request's asker no longer speaking for the
 * sending association (D38b): the request is voided (`withdrawn`), never applied.
 */
export const PROPOSAL_SENDER_GONE = 'PROPOSAL_SENDER_GONE';

/** Work owed once the decision has COMMITTED - a notification, a cache sweep. Never inside it. */
export type AfterCommit = () => Promise<void>;

/** A proposal whose receiver is an ASSOCIATION (`repost`, `coorganise`) - migration 096's CHECKs. */
export type AssociationProposal = Omit<Proposal, 'toAssociationId' | 'toUserId'> & {
  toAssociationId: string;
  toUserId: null;
};

/** A proposal whose receiver is a PERSON (`repost-personal`, D38b) - migration 096's CHECKs. */
export type UserProposal = Omit<Proposal, 'toAssociationId' | 'toUserId'> & {
  toAssociationId: null;
  toUserId: string;
};

/** How an association is shown beside a proposal. */
export interface ProposalAssociationView {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
}

/** How a person is shown beside a proposal: their name, or null when the account has none left. */
export interface ProposalUserView {
  id: string;
  name: string | null;
}

/** One proposal as the management page's queue draws it. */
export interface ProposalView {
  id: string;
  kind: ProposalKind;
  status: ProposalStatus;
  /**
   * Null for a person-addressed request whose post the caller may not see (D38b): not even an
   * identifier of it is told, since `/posts/:id` would answer what the queue withheld.
   */
  subjectId: string | null;
  /** What the kind's handler says about the subject (a post's opening and its publisher, ...). */
  subject: Record<string, unknown> | null;
  from: ProposalAssociationView;
  /** The receiving association; null for a kind whose receiver is a person (`toUser`). */
  to: ProposalAssociationView | null;
  /** The receiving person (D38b); null for an association kind. */
  toUser: ProposalUserView | null;
  createdAt: Date;
}

/**
 * One request in a PERSON's inbox (D38b): who asks, in which association's name, about what, and
 * what accepting would change - so the answer is an informed one.
 */
export interface UserProposalView {
  id: string;
  kind: ProposalKind;
  status: ProposalStatus;
  subjectId: string;
  from: ProposalAssociationView;
  /** The member who pressed "ask"; null once their account is erased. */
  proposedBy: ProposalUserView | null;
  /** What the kind's handler says about the request (the post, the readers it would newly reach). */
  details: Record<string, unknown> | null;
  createdAt: Date;
}

/**
 * WHAT ONE KIND OF PROPOSAL BETWEEN ASSOCIATIONS MEANS. The state machine (pending -> accepted |
 * refused | withdrawn), the rights and the queue are this service's and are the same for every
 * kind; a handler says only what is proposed, who may send and decide it, and what accepting it
 * DOES.
 *
 * A handler registers itself (`ProposalsService.register`) from its own module, so this module
 * imports none of them: `repost` lives with the posts, `coorganise` (D39) in `coorganisation/`.
 */
export interface ProposalKindHandler {
  readonly kind: ProposalKind;
  /** Held in the SENDING association, to propose and to withdraw. */
  readonly senderFlag: AssociationPermissionFlag;
  /** Held in the RECEIVING association, to accept or refuse. */
  readonly acceptorFlag: AssociationPermissionFlag;
  /**
   * The sending association for this subject, after refusing (with a typed HTTP error) a subject
   * that may not be proposed to `toAssociationId` at all.
   */
  resolveSender(subjectId: string, toAssociationId: string): Promise<string>;
  /**
   * Row-locks the SUBJECT before the decision locks the proposal, when `apply` locks the subject:
   * every other writer (a moderation hide, a delete) takes the subject first and the proposals
   * after, so the decision must take them in the same order or the two can deadlock.
   */
  lockSubject?(manager: EntityManager, subjectId: string): Promise<void>;
  /**
   * Does what accepting means, INSIDE the transaction that records the acceptance - so a failure
   * here leaves the proposal pending. Returns what to do once it has committed.
   */
  apply(
    manager: EntityManager,
    proposal: AssociationProposal,
    actorId: string
  ): Promise<AfterCommit>;
  /** Tells the receiving association's acceptors a proposal is waiting. Best effort. */
  announce(proposal: AssociationProposal, acceptorIds: string[]): Promise<void>;
  /** A short description of each subject, for the queue. A missing id is a subject gone. */
  describe(subjectIds: string[]): Promise<Map<string, Record<string, unknown>>>;
}

/**
 * WHAT ONE KIND OF PROPOSAL TO A PERSON MEANS (D38b). Same state machine and same table; what
 * differs is the receiver: ONE user, named by the subject itself, who alone accepts or refuses -
 * no association flag, no administrator standing in for them, because what is asked is their
 * consent.
 */
export interface UserProposalKindHandler {
  readonly kind: ProposalKind;
  /** The discriminant: this kind's receiver is a person. */
  readonly target: 'user';
  /** Held in the SENDING association, to propose and to withdraw. */
  readonly senderFlag: AssociationPermissionFlag;
  /**
   * The person who decides, after refusing (with a typed HTTP error) a subject `fromAssociationId`
   * may not propose. Runs INSIDE the transaction that inserts the row, so a cap it counts and the
   * row it guards are one decision.
   */
  resolveRecipient(
    manager: EntityManager,
    subjectId: string,
    fromAssociationId: string,
    actorId: string
  ): Promise<string>;
  /** As `ProposalKindHandler.lockSubject`, and not optional: `apply` locks the subject. */
  lockSubject(manager: EntityManager, subjectId: string): Promise<void>;
  /**
   * Whether the member who asked STILL speaks for the sending association - the sender flag held,
   * the account not restricted - judged inside the acceptance's transaction. A request whose asker
   * left (or was muted) must not publish in the association's name: it is voided, never applied.
   */
  senderStillSpeaks(manager: EntityManager, proposal: UserProposal): Promise<boolean>;
  /**
   * The same judgement as SQL over a `proposals` row aliased `alias` - the ONE predicate behind
   * `senderStillSpeaks`, the caps, the person's inbox and its count, so a request whose asker no
   * longer speaks is neither shown, nor counted, nor applied.
   */
  senderSpeaksSql(alias: string): string;
  /** As `ProposalKindHandler.apply`: inside the acceptance's transaction. */
  apply(manager: EntityManager, proposal: UserProposal, actorId: string): Promise<AfterCommit>;
  /**
   * Tells the person a request is waiting. Best effort, and called for the FIRST ask of a (subject,
   * sending association) pair only: a request withdrawn and asked again is not announced twice.
   */
  announce(proposal: UserProposal): Promise<void>;
  /**
   * Undoes, inside the withdrawal's transaction, what `announce` left in the person's bell - a
   * request taken back is not a thing to answer any more.
   */
  withdrawn(manager: EntityManager, proposal: UserProposal): Promise<void>;
  /** Tells the proposer what the person decided, once it has committed. Best effort. */
  decided(proposal: UserProposal): Promise<void>;
  /**
   * A short description of each subject, for the SENDING association's queue - of the subjects
   * `viewerId` may see only: a member of the sending association who cannot see the post learns
   * nothing about it (absent from the map, so the queue shows neither it nor whom it was asked of).
   */
  describe(subjectIds: string[], viewerId: string): Promise<Map<string, Record<string, unknown>>>;
  /** What the person's inbox shows about each request, keyed by proposal id. */
  describeRequests(proposals: UserProposal[]): Promise<Map<string, Record<string, unknown>>>;
}

type AnyHandler = ProposalKindHandler | UserProposalKindHandler;

function isUserHandler(handler: AnyHandler): handler is UserProposalKindHandler {
  return 'target' in handler && handler.target === 'user';
}

function isUserProposal(proposal: Proposal): proposal is UserProposal {
  return proposal.toUserId !== null && proposal.toUserId !== undefined;
}

/**
 * PROPOSALS (migration 073, widened by 096): an association asks, another association - or, for a
 * user kind, one person - decides, and no clock does either. Idempotent by the table's unique
 * indexes, never by a check-then-insert: the same (kind, subject, receiver) cannot be pending or
 * decided twice, and a second ask is a 409.
 */
@Injectable()
export class ProposalsService {
  private readonly logger = new Logger(ProposalsService.name);
  private readonly handlers = new Map<ProposalKind, AnyHandler>();

  constructor(
    @InjectRepository(Proposal) private readonly repo: Repository<Proposal>,
    private readonly associations: AssociationsService
  ) {}

  /** Called once per kind, by the module that owns it. A second registration is a wiring defect. */
  register(handler: AnyHandler): void {
    if (this.handlers.has(handler.kind)) {
      throw new Error(`proposal kind ${handler.kind} registered twice`);
    }
    this.handlers.set(handler.kind, handler);
    this.logger.log(
      `[PROPOSAL] kind ${handler.kind} registered (${isUserHandler(handler) ? 'user' : 'association'} receiver)`
    );
  }

  private handler(kind: ProposalKind): AnyHandler {
    const handler = this.handlers.get(kind);
    if (!handler) throw new BadRequestException(`Unknown proposal kind ${kind}`);
    return handler;
  }

  /** The handler of an ASSOCIATION kind; a user kind asked through an association route is a 400. */
  private associationHandler(kind: ProposalKind): ProposalKindHandler {
    const handler = this.handler(kind);
    if (isUserHandler(handler)) {
      throw new BadRequestException(`Proposal kind ${kind} is addressed to a person`);
    }
    return handler;
  }

  /** The handler of a USER kind; an association kind asked through a person's route is a 400. */
  private userHandler(kind: ProposalKind): UserProposalKindHandler {
    const handler = this.handler(kind);
    if (!isUserHandler(handler)) {
      throw new BadRequestException(`Proposal kind ${kind} is addressed to an association`);
    }
    return handler;
  }

  /**
   * `actorId` asks `toAssociationId` to accept `subjectId`, in the name of the association the
   * handler resolves as the sender. 403 without the sender flag there; 409 when the same proposal
   * already stands (pending, accepted or refused). The acceptors are told after the row is stored.
   *
   * `senderVouched`: the caller has ALREADY established that the actor speaks for the sending
   * association by a rule of the subject itself - the event write check, for `coorganise`, which
   * also admits the BDE validator governing the organiser. The sender flag is then not asked again;
   * the decision stays the receiver's, and that check is never skipped.
   */
  async propose(
    kind: ProposalKind,
    subjectId: string,
    toAssociationId: string,
    actorId: string,
    isGlobalAdmin: boolean,
    opts: { senderVouched?: boolean } = {}
  ): Promise<Proposal> {
    const handler = this.associationHandler(kind);
    const fromAssociationId = await handler.resolveSender(subjectId, toAssociationId);
    if (opts.senderVouched === true) {
      this.logger.debug(`[PROPOSAL] ${kind} by ${actorId.slice(0, 8)}: sender right vouched`);
    }
    const maySend =
      opts.senderVouched === true ||
      (await this.associations.mayAct(actorId, fromAssociationId, handler.senderFlag, {
        isGlobalAdmin,
      }));
    if (!maySend) {
      this.logger.debug(
        `[PROPOSAL] ${actorId.slice(0, 8)} refused: no sender flag in ${fromAssociationId.slice(0, 8)}`
      );
      throw new ForbiddenException('You may not propose in this association name');
    }
    let saved: Proposal;
    try {
      saved = await this.repo.save(
        this.repo.create({
          kind,
          subjectId,
          fromAssociationId,
          toAssociationId,
          toUserId: null,
          status: 'pending',
          proposedBy: actorId,
          decidedBy: null,
          decidedAt: null,
        })
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        this.logger.debug(
          `[PROPOSAL] ${kind} ${subjectId.slice(0, 8)} -> ${toAssociationId.slice(0, 8)} already stands`
        );
        throw new ConflictException('This proposal has already been made');
      }
      throw err;
    }
    this.logger.log(
      `[PROPOSAL] ${kind} ${saved.id.slice(0, 8)}: ${fromAssociationId.slice(0, 8)} -> ${toAssociationId.slice(0, 8)} by ${actorId.slice(0, 8)}`
    );
    try {
      const acceptorIds = await this.holdersOf(toAssociationId, handler.acceptorFlag);
      await handler.announce(saved as AssociationProposal, acceptorIds);
    } catch (e: unknown) {
      // The proposal is stored and sits in the queue whatever happens here; what a failure loses is
      // the notification, and this line is all that loss leaves.
      this.logger.warn(`[PROPOSAL] ${saved.id} stored but its acceptors were not told`, e);
    }
    return saved;
  }

  /**
   * D38b: `actorId`, speaking for `fromAssociationId`, asks the PERSON the handler resolves from
   * `subjectId`. The sender flag must be HELD there - no administrator tier stands in for the
   * association's own voice when what is asked is somebody's consent. The handler's refusals and
   * the insert run in ONE transaction; the person is told after it commits.
   */
  async proposeToUser(
    kind: ProposalKind,
    subjectId: string,
    fromAssociationId: string,
    actorId: string
  ): Promise<Proposal> {
    const handler = this.userHandler(kind);
    const maySend = await this.associations.mayAct(actorId, fromAssociationId, handler.senderFlag, {
      isGlobalAdmin: false,
    });
    if (!maySend) {
      this.logger.debug(
        `[PROPOSAL] ${kind} by ${actorId.slice(0, 8)} refused: no sender flag in ${fromAssociationId.slice(0, 8)}`
      );
      throw new ForbiddenException('You may not propose in this association name');
    }
    let saved: UserProposal;
    let askedBefore = false;
    try {
      saved = await this.repo.manager.transaction(async (manager) => {
        await this.lockInOrder(manager, handler, subjectId, [fromAssociationId]);
        const toUserId = await handler.resolveRecipient(
          manager,
          subjectId,
          fromAssociationId,
          actorId
        );
        // A request of this pair whose asker no longer speaks holds the pair's place in the unique
        // index: voided here, where it is found, so another officer may ask.
        await this.voidSilenced(manager, handler, subjectId, fromAssociationId);
        // DURABLE STATE, NOT A CLOCK: a withdrawn request of the same pair is the record that the
        // person was already told once. Withdrawing frees the pair (it may be asked again), but an
        // ask -> withdraw -> ask loop must not become a push per cycle.
        const earlier: unknown[] = await manager.query(
          `SELECT 1 FROM proposals
            WHERE kind = $1 AND "subjectId" = $2 AND "fromAssociationId" = $3 AND "toUserId" = $4
            LIMIT 1`,
          [kind, subjectId, fromAssociationId, toUserId]
        );
        askedBefore = earlier.length > 0;
        const inserted: UserProposal[] = await manager.query(
          `INSERT INTO proposals (kind, "subjectId", "fromAssociationId", "toAssociationId",
                                  "toUserId", status, "proposedBy")
             VALUES ($1, $2, $3, NULL, $4, 'pending', $5) RETURNING *`,
          [kind, subjectId, fromAssociationId, toUserId, actorId]
        );
        return inserted[0];
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        this.logger.debug(
          `[PROPOSAL] ${kind} ${subjectId.slice(0, 8)} from ${fromAssociationId.slice(0, 8)} already stands`
        );
        throw new ConflictException('This proposal has already been made');
      }
      throw err;
    }
    this.logger.log(
      `[PROPOSAL] ${kind} ${saved.id.slice(0, 8)}: ${fromAssociationId.slice(0, 8)} -> user ${saved.toUserId.slice(0, 8)} by ${actorId.slice(0, 8)}`
    );
    if (askedBefore) {
      this.logger.log(
        `[PROPOSAL] ${saved.id.slice(0, 8)} asked again after a withdrawal: in the inbox, not announced`
      );
      return saved;
    }
    try {
      await handler.announce(saved);
    } catch (e: unknown) {
      // Stored and in the person's inbox whatever happens here: the loss is the notification alone.
      this.logger.warn(`[PROPOSAL] ${saved.id} stored but its recipient was not told`, e);
    }
    return saved;
  }

  /**
   * Accepts a pending proposal: the acceptor flag in the RECEIVING association - or, for a user
   * kind, being the person it was addressed to, and nobody else.
   */
  async accept(proposalId: string, actorId: string, isGlobalAdmin: boolean): Promise<Proposal> {
    const proposal = await this.load(proposalId);
    const handler = this.handler(proposal.kind);
    let after: AfterCommit = () => Promise.resolve();
    if (isUserHandler(handler)) {
      const asked = this.assertRecipient(proposal, actorId);
      const outcome = await this.repo.manager.transaction(async (manager) => {
        await this.lockInOrder(manager, handler, asked.subjectId, [asked.fromAssociationId]);
        if (!(await handler.senderStillSpeaks(manager, asked))) {
          // Voided by the server, not decided by the person asked: `decidedBy` names neither.
          const voided = (await this.decide(
            manager,
            asked.id,
            'withdrawn',
            PROPOSAL_VOIDED_BY
          )) as UserProposal;
          await handler.withdrawn(manager, voided);
          return { voided };
        }
        const row = await this.decide(manager, asked.id, 'accepted', actorId);
        after = await handler.apply(manager, row as UserProposal, actorId);
        return { decided: row as UserProposal };
      });
      if ('voided' in outcome) {
        this.logger.log(
          `[PROPOSAL] ${asked.id.slice(0, 8)} voided at acceptance: its asker no longer speaks for ${asked.fromAssociationId.slice(0, 8)}`
        );
        throw new ConflictException({
          code: PROPOSAL_SENDER_GONE,
          message: 'Whoever asked no longer speaks for this association',
        });
      }
      const decided = outcome.decided;
      this.logger.log(`[PROPOSAL] ${decided.id.slice(0, 8)} accepted by its recipient`);
      await after();
      await this.tellProposer(handler, decided);
      return decided;
    }
    const target = this.associationTarget(proposal);
    await this.assertMay(actorId, target.toAssociationId, handler.acceptorFlag, isGlobalAdmin);
    const decided = await this.repo.manager.transaction(async (manager) => {
      await this.lockInOrder(manager, handler, proposal.subjectId, [
        proposal.fromAssociationId,
        target.toAssociationId,
      ]);
      const row = await this.decide(manager, proposal.id, 'accepted', actorId);
      after = await handler.apply(manager, row as AssociationProposal, actorId);
      return row;
    });
    this.logger.log(`[PROPOSAL] ${decided.id.slice(0, 8)} accepted by ${actorId.slice(0, 8)}`);
    await after();
    return decided;
  }

  /** Refuses a pending proposal. The refusal is recorded and the same proposal cannot be made again. */
  async refuse(proposalId: string, actorId: string, isGlobalAdmin: boolean): Promise<Proposal> {
    const proposal = await this.load(proposalId);
    const handler = this.handler(proposal.kind);
    if (isUserHandler(handler)) {
      const asked = this.assertRecipient(proposal, actorId);
      const decided = await this.repo.manager.transaction(async (manager) => {
        await this.lockInOrder(manager, handler, asked.subjectId, [asked.fromAssociationId]);
        return this.decide(manager, asked.id, 'refused', actorId);
      });
      this.logger.log(`[PROPOSAL] ${decided.id.slice(0, 8)} refused by its recipient`);
      await this.tellProposer(handler, decided as UserProposal);
      return decided;
    }
    const target = this.associationTarget(proposal);
    await this.assertMay(actorId, target.toAssociationId, handler.acceptorFlag, isGlobalAdmin);
    const decided = await this.repo.manager.transaction(async (manager) => {
      await this.lockInOrder(manager, handler, proposal.subjectId, [
        proposal.fromAssociationId,
        target.toAssociationId,
      ]);
      return this.decide(manager, proposal.id, 'refused', actorId);
    });
    this.logger.log(`[PROPOSAL] ${decided.id.slice(0, 8)} refused by ${actorId.slice(0, 8)}`);
    return decided;
  }

  /**
   * Withdraws a pending proposal: the sender flag in the SENDING association. For a user kind the
   * flag must be HELD (as when it was sent), never granted by the administrator tier.
   *
   * Answers the id and the new status ONLY: the sender may be an officer who cannot see a personal
   * post (D38b), and the row names its author (`toUserId`) and the post.
   */
  async withdraw(
    proposalId: string,
    actorId: string,
    isGlobalAdmin: boolean
  ): Promise<{ id: string; status: ProposalStatus }> {
    const proposal = await this.load(proposalId);
    const handler = this.handler(proposal.kind);
    const adminTier = isUserHandler(handler) ? false : isGlobalAdmin;
    await this.assertMay(actorId, proposal.fromAssociationId, handler.senderFlag, adminTier);
    const decided = await this.repo.manager.transaction(async (manager) => {
      await this.lockInOrder(manager, handler, proposal.subjectId, [
        proposal.fromAssociationId,
        proposal.toAssociationId,
      ]);
      const row = await this.decide(manager, proposal.id, 'withdrawn', actorId);
      if (isUserHandler(handler)) await handler.withdrawn(manager, row as UserProposal);
      return row;
    });
    this.logger.log(`[PROPOSAL] ${decided.id.slice(0, 8)} withdrawn by ${actorId.slice(0, 8)}`);
    return { id: decided.id, status: decided.status };
  }

  /**
   * The pending proposals an association's management page shows THIS caller: those it RECEIVED,
   * of the kinds whose acceptor flag the caller holds there, and those it SENT, of the kinds whose
   * sender flag they hold - a person-addressed request (D38b) included, so the association sees
   * what it waits on and may withdraw it. 403 when they hold neither for any kind.
   */
  async listPending(
    associationId: string,
    actorId: string,
    isGlobalAdmin: boolean
  ): Promise<{ incoming: ProposalView[]; outgoing: ProposalView[] }> {
    const acceptKinds: ProposalKind[] = [];
    const sendKinds: ProposalKind[] = [];
    for (const handler of this.handlers.values()) {
      if (isUserHandler(handler)) {
        // Only sent from here; held, never granted by the administrator tier (see `proposeToUser`).
        const opts = { isGlobalAdmin: false };
        if (await this.associations.mayAct(actorId, associationId, handler.senderFlag, opts)) {
          sendKinds.push(handler.kind);
        }
        continue;
      }
      const opts = { isGlobalAdmin };
      if (await this.associations.mayAct(actorId, associationId, handler.acceptorFlag, opts)) {
        acceptKinds.push(handler.kind);
      }
      if (await this.associations.mayAct(actorId, associationId, handler.senderFlag, opts)) {
        sendKinds.push(handler.kind);
      }
    }
    if (acceptKinds.length === 0 && sendKinds.length === 0) {
      this.logger.debug(
        `[PROPOSAL] queue of ${associationId.slice(0, 8)} refused to ${actorId.slice(0, 8)}`
      );
      throw new ForbiddenException('You may not see this association proposals');
    }
    const rows: (Proposal & {
      fromName: string;
      fromSlug: string;
      fromLogoUrl: string | null;
      toName: string | null;
      toSlug: string | null;
      toLogoUrl: string | null;
    })[] = await this.repo.manager.query(
      `SELECT p.*, fa.name AS "fromName", fa.slug AS "fromSlug", fa."logoUrl" AS "fromLogoUrl",
              ta.name AS "toName", ta.slug AS "toSlug", ta."logoUrl" AS "toLogoUrl"
         FROM proposals p
         JOIN associations fa ON fa.id = p."fromAssociationId"
         LEFT JOIN associations ta ON ta.id = p."toAssociationId"
        WHERE p.status = 'pending'
          AND ((p."toAssociationId" = $1 AND p.kind = ANY($2::text[]))
            OR (p."fromAssociationId" = $1 AND p.kind = ANY($3::text[])))
        ORDER BY p."createdAt" ASC`,
      [associationId, acceptKinds, sendKinds]
    );
    const subjects = new Map<string, Record<string, unknown>>();
    for (const kind of new Set(rows.map((r) => r.kind))) {
      const handler = this.handler(kind);
      const ids = rows.filter((r) => r.kind === kind).map((r) => r.subjectId);
      // A person-addressed kind describes only what THIS caller may see (D38b): an officer who
      // cannot see the post learns neither its text nor whose it is.
      const described = isUserHandler(handler)
        ? await handler.describe(ids, actorId)
        : await handler.describe(ids);
      for (const [id, subject] of described) subjects.set(`${kind}:${id}`, subject);
    }
    // The person asked is named only beside a subject the caller was allowed to see.
    const namedTarget = (r: (typeof rows)[number]): string | null =>
      r.toUserId && subjects.has(`${r.kind}:${r.subjectId}`) ? r.toUserId : null;
    const userNames = await this.userNames(
      rows.map(namedTarget).filter((id): id is string => !!id)
    );
    // A person-addressed subject the caller was not described is not identified either.
    const seenSubjectId = (r: (typeof rows)[number]): string | null =>
      r.toUserId && !subjects.has(`${r.kind}:${r.subjectId}`) ? null : r.subjectId;
    const view = (r: (typeof rows)[number]): ProposalView => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      subjectId: seenSubjectId(r),
      subject: subjects.get(`${r.kind}:${r.subjectId}`) ?? null,
      from: { id: r.fromAssociationId, name: r.fromName, slug: r.fromSlug, logoUrl: r.fromLogoUrl },
      to:
        r.toAssociationId && r.toName !== null && r.toSlug !== null
          ? { id: r.toAssociationId, name: r.toName, slug: r.toSlug, logoUrl: r.toLogoUrl }
          : null,
      toUser: namedTarget(r)
        ? { id: r.toUserId as string, name: userNames.get(r.toUserId as string) ?? null }
        : null,
      createdAt: r.createdAt,
    });
    const incoming = rows.filter((r) => r.toAssociationId === associationId).map(view);
    const outgoing = rows.filter((r) => r.fromAssociationId === associationId).map(view);
    this.logger.debug(
      `[PROPOSAL] queue of ${associationId.slice(0, 8)}: ${incoming.length} in, ${outgoing.length} out`
    );
    return { incoming, outgoing };
  }

  /**
   * D38b: how many requests wait for `userId`'s answer - ONE indexed count, for a page that only
   * needs to know whether to show the way to the inbox (`IDX_proposals_user_target_pending`).
   */
  async countForUser(userId: string): Promise<number> {
    const rows: { n: number }[] = await this.repo.manager.query(
      `SELECT count(*)::int AS n FROM proposals p
        WHERE p."toUserId" = $1 AND p.status = 'pending' AND ${this.senderSpeaksSql('p')}`,
      [userId]
    );
    return rows[0]?.n ?? 0;
  }

  /**
   * D38b: the requests waiting for `userId`'s answer, oldest first - the person's own inbox. Nobody
   * else reads it: the route passes the caller, never an id from the URL.
   */
  async listForUser(userId: string): Promise<{ incoming: UserProposalView[] }> {
    const rows: (UserProposal & {
      fromName: string;
      fromSlug: string;
      fromLogoUrl: string | null;
    })[] = await this.repo.manager.query(
      `SELECT p.*, fa.name AS "fromName", fa.slug AS "fromSlug", fa."logoUrl" AS "fromLogoUrl"
         FROM proposals p
         JOIN associations fa ON fa.id = p."fromAssociationId"
        WHERE p."toUserId" = $1 AND p.status = 'pending' AND ${this.senderSpeaksSql('p')}
        ORDER BY p."createdAt" ASC`,
      [userId]
    );
    const details = new Map<string, Record<string, unknown>>();
    for (const kind of new Set(rows.map((r) => r.kind))) {
      const handler = this.handlers.get(kind);
      if (!handler || !isUserHandler(handler)) {
        // A row of a kind with no user handler cannot be decided by this person: an accusation, not
        // a skip - the CHECKs of 096 say it cannot exist.
        this.logger.warn(`[PROPOSAL] inbox of ${userId.slice(0, 8)} holds a ${kind} row`);
        continue;
      }
      const described = await handler.describeRequests(rows.filter((r) => r.kind === kind));
      for (const [id, detail] of described) details.set(id, detail);
    }
    const proposerNames = await this.userNames(rows.map((r) => r.proposedBy));
    const incoming = rows.map((r): UserProposalView => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      subjectId: r.subjectId,
      from: {
        id: r.fromAssociationId,
        name: r.fromName,
        slug: r.fromSlug,
        logoUrl: r.fromLogoUrl,
      },
      proposedBy: proposerNames.has(r.proposedBy)
        ? { id: r.proposedBy, name: proposerNames.get(r.proposedBy) ?? null }
        : null,
      details: details.get(r.id) ?? null,
      createdAt: r.createdAt,
    }));
    this.logger.debug(`[PROPOSAL] inbox of ${userId.slice(0, 8)}: ${incoming.length} pending`);
    return { incoming };
  }

  /**
   * Moves the `kind` proposal of (`subjectId`, `toAssociationId`) from `from` to `withdrawn` inside
   * `manager`'s transaction, and returns it - or null when none is in that state. For a kind whose
   * handler ENDS what was accepted (a co-organiser leaving, D39) as well as a pending one being
   * withdrawn: the row frees its place in the unique index, so the pair may be proposed again. The
   * CALLER owns the rights; this owns only the conditional write, so two racing enders get one row
   * and one null.
   */
  async withdrawBySubject(
    manager: EntityManager,
    kind: ProposalKind,
    subjectId: string,
    toAssociationId: string,
    from: 'pending' | 'accepted',
    actorId: string
  ): Promise<Proposal | null> {
    const result: unknown = await manager.query(
      `UPDATE proposals SET status = 'withdrawn', "decidedBy" = $5, "decidedAt" = now()
        WHERE kind = $1 AND "subjectId" = $2 AND "toAssociationId" = $3 AND status = $4
        RETURNING *`,
      [kind, subjectId, toAssociationId, from, actorId]
    );
    const row = firstReturned(result);
    this.logger.log(
      `[PROPOSAL] ${kind} ${subjectId.slice(0, 8)} -> ${toAssociationId.slice(0, 8)}: ${from} -> withdrawn by ${actorId.slice(0, 8)} (${row ? 'done' : 'none'})`
    );
    return row;
  }

  /**
   * THE LOCK ORDER OF EVERY PROPOSAL WRITE: the associations involved (`FOR KEY SHARE`), then the
   * subject (the handler's `lockSubject`: a post `FOR UPDATE`), then - by the caller's conditional
   * `UPDATE` - the proposal. Each other writer of these rows takes them in the same order:
   *
   * - a moderation hide and a post delete lock the post, then delete its pending proposals;
   * - the account erasure scrubs posts BEFORE it touches a proposal (`ERASURE_PROPOSAL_STATEMENTS`);
   * - an association delete locks the association first, then cascades into its posts and
   *   proposals: the `KEY SHARE` here waits on it, holding nothing it needs, instead of holding the
   *   post while it waits on a proposal the cascade already took.
   *
   * A `KEY SHARE` blocks only a delete or a key change of the association, never an edit of it.
   */
  private async lockInOrder(
    manager: EntityManager,
    handler: AnyHandler,
    subjectId: string,
    associationIds: (string | null)[]
  ): Promise<void> {
    const ids = associationIds.filter((id): id is string => !!id);
    await manager.query(`SELECT 1 FROM associations WHERE id = ANY($1::uuid[]) FOR KEY SHARE`, [
      ids,
    ]);
    if (handler.lockSubject) await handler.lockSubject(manager, subjectId);
  }

  /**
   * Voids, inside `manager`'s transaction, the pending request of (`subjectId`, `fromAssociationId`)
   * whose asker no longer speaks for the association - `decidedBy` {@link PROPOSAL_VOIDED_BY}, its
   * bell row gone with it (`withdrawn`). Returns how many it voided (0 or 1, by the unique index).
   */
  private async voidSilenced(
    manager: EntityManager,
    handler: UserProposalKindHandler,
    subjectId: string,
    fromAssociationId: string
  ): Promise<number> {
    const result: unknown = await manager.query(
      `UPDATE proposals p SET status = 'withdrawn', "decidedBy" = $4, "decidedAt" = now()
        WHERE p.kind = $1 AND p."subjectId" = $2 AND p."fromAssociationId" = $3
          AND p.status = 'pending' AND NOT ${handler.senderSpeaksSql('p')}
        RETURNING p.*`,
      [handler.kind, subjectId, fromAssociationId, PROPOSAL_VOIDED_BY]
    );
    const rows = Array.isArray(result) && Array.isArray(result[0]) ? (result[0] as Proposal[]) : [];
    for (const row of rows) {
      this.logger.log(
        `[PROPOSAL] ${row.id.slice(0, 8)} voided at a new ask: its asker no longer speaks for ${fromAssociationId.slice(0, 8)}`
      );
      await handler.withdrawn(manager, row as UserProposal);
    }
    return rows.length;
  }

  /**
   * Over a `proposals` row aliased `alias`: TRUE for an association kind, and for a person-addressed
   * kind only while its asker still speaks (each user handler's `senderSpeaksSql`). The kinds are
   * this service's own constants, never input.
   */
  private senderSpeaksSql(alias: string): string {
    const userKinds = [...this.handlers.values()].filter(isUserHandler);
    if (userKinds.length === 0) return 'true';
    const each = userKinds.map(
      (h) => `(${alias}.kind = '${h.kind}' AND ${h.senderSpeaksSql(alias)})`
    );
    const names = userKinds.map((h) => `'${h.kind}'`).join(', ');
    return `(${alias}.kind NOT IN (${names}) OR ${each.join(' OR ')})`;
  }

  private async load(proposalId: string): Promise<Proposal> {
    const proposal = await this.repo.findOne({ where: { id: proposalId } });
    if (!proposal) throw new NotFoundException('Proposal not found');
    return proposal;
  }

  /**
   * The person a user-kind proposal was addressed to, and only them, decides it. A global
   * administrator does not stand in: what is asked is that person's consent (D38b).
   */
  private assertRecipient(proposal: Proposal, actorId: string): UserProposal {
    if (!isUserProposal(proposal) || proposal.toUserId !== actorId) {
      this.logger.debug(
        `[PROPOSAL] ${actorId.slice(0, 8)} may not decide ${proposal.id.slice(0, 8)}: not its recipient`
      );
      throw new ForbiddenException('You may not decide this proposal');
    }
    return proposal;
  }

  /** An association kind's row, whose receiver migration 096's CHECKs guarantee is an association. */
  private associationTarget(proposal: Proposal): AssociationProposal {
    if (!proposal.toAssociationId) {
      // The CHECKs of 096 tie the kind to the receiver: reaching this is a schema that lost them.
      this.logger.error(`[PROPOSAL] ${proposal.id} of kind ${proposal.kind} has no association`);
      throw new ConflictException('This proposal has no receiving association');
    }
    return proposal as AssociationProposal;
  }

  /** Tells the proposer of a user-kind proposal what the person decided. Best effort, logged. */
  private async tellProposer(handler: UserProposalKindHandler, decided: UserProposal) {
    try {
      await handler.decided(decided);
    } catch (e: unknown) {
      this.logger.warn(
        `[PROPOSAL] ${decided.id} ${decided.status} but its proposer was not told`,
        e
      );
    }
  }

  private async assertMay(
    actorId: string,
    associationId: string,
    flag: AssociationPermissionFlag,
    isGlobalAdmin: boolean
  ): Promise<void> {
    if (await this.associations.mayAct(actorId, associationId, flag, { isGlobalAdmin })) return;
    this.logger.debug(
      `[PROPOSAL] ${actorId.slice(0, 8)} lacks flag ${flag} in ${associationId.slice(0, 8)}`
    );
    throw new ForbiddenException('You may not decide this proposal');
  }

  /**
   * Moves a PENDING proposal to `status`, atomically: the `WHERE status = 'pending'` is the whole
   * guard, so two acceptors racing get one acceptance and one 409, never two.
   */
  private async decide(
    manager: EntityManager,
    proposalId: string,
    status: Exclude<ProposalStatus, 'pending'>,
    actorId: string
  ): Promise<Proposal> {
    const result: unknown = await manager.query(
      `UPDATE proposals SET status = $2, "decidedBy" = $3, "decidedAt" = now()
        WHERE id = $1 AND status = 'pending' RETURNING *`,
      [proposalId, status, actorId]
    );
    const row = firstReturned(result);
    if (!row) {
      this.logger.debug(`[PROPOSAL] ${proposalId.slice(0, 8)} is no longer pending`);
      throw new ConflictException('This proposal has already been decided');
    }
    return row;
  }

  /** Members of `associationId` holding `flag` - the people a new proposal is announced to. */
  private async holdersOf(associationId: string, flag: AssociationPermissionFlag) {
    const rows: { userId: string }[] = await this.repo.manager.query(
      `SELECT "userId" FROM association_members WHERE "associationId" = $1 AND (permissions & $2) <> 0`,
      [associationId, flag]
    );
    return rows.map((r) => r.userId);
  }

  /**
   * The display names of `userIds`, ONE query, none at all for an empty list. An id absent from
   * the map is an account that no longer exists (an erased proposer reads `[deleted]`).
   */
  private async userNames(userIds: string[]): Promise<Map<string, string | null>> {
    const names = new Map<string, string | null>();
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return names;
    const rows: (Record<string, unknown> & { id: string })[] = await this.repo.manager.query(
      `SELECT id, "displayName", "firstName", "lastName" FROM users WHERE id = ANY($1::varchar[])`,
      [ids]
    );
    for (const row of rows) names.set(row.id, formatUserDisplayNameFromRaw(row) || null);
    return names;
  }
}
