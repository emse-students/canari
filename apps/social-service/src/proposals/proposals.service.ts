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
import { Proposal, type ProposalKind, type ProposalStatus } from './proposal.entity';

/** The first row of an `UPDATE ... RETURNING`, which node-postgres answers as [rows, count] via TypeORM. */
function firstReturned(result: unknown): Proposal | null {
  const rows = Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result;
  return Array.isArray(rows) ? ((rows[0] as Proposal | undefined) ?? null) : null;
}

/** Work owed once the decision has COMMITTED - a notification, a cache sweep. Never inside it. */
export type AfterCommit = () => Promise<void>;

/** How an association is shown beside a proposal. */
export interface ProposalAssociationView {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
}

/** One proposal as the management page's queue draws it. */
export interface ProposalView {
  id: string;
  kind: ProposalKind;
  status: ProposalStatus;
  subjectId: string;
  /** What the kind's handler says about the subject (a post's opening and its publisher, ...). */
  subject: Record<string, unknown> | null;
  from: ProposalAssociationView;
  to: ProposalAssociationView;
  createdAt: Date;
}

/**
 * WHAT ONE KIND OF PROPOSAL MEANS. The state machine (pending -> accepted | refused | withdrawn),
 * the rights and the queue are this service's and are the same for every kind; a handler says only
 * what is proposed, who may send and decide it, and what accepting it DOES.
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
   * Does what accepting means, INSIDE the transaction that records the acceptance - so a failure
   * here leaves the proposal pending. Returns what to do once it has committed.
   */
  apply(manager: EntityManager, proposal: Proposal, actorId: string): Promise<AfterCommit>;
  /** Tells the receiving association's acceptors a proposal is waiting. Best effort. */
  announce(proposal: Proposal, acceptorIds: string[]): Promise<void>;
  /** A short description of each subject, for the queue. A missing id is a subject gone. */
  describe(subjectIds: string[]): Promise<Map<string, Record<string, unknown>>>;
}

/**
 * PROPOSALS BETWEEN ASSOCIATIONS (migration 073): one association asks, another decides, and no
 * clock does either. Idempotent by the table's unique index, never by a check-then-insert: the same
 * (kind, subject, target) cannot be pending or decided twice, and a second ask is a 409.
 */
@Injectable()
export class ProposalsService {
  private readonly logger = new Logger(ProposalsService.name);
  private readonly handlers = new Map<ProposalKind, ProposalKindHandler>();

  constructor(
    @InjectRepository(Proposal) private readonly repo: Repository<Proposal>,
    private readonly associations: AssociationsService
  ) {}

  /** Called once per kind, by the module that owns it. A second registration is a wiring defect. */
  register(handler: ProposalKindHandler): void {
    if (this.handlers.has(handler.kind)) {
      throw new Error(`proposal kind ${handler.kind} registered twice`);
    }
    this.handlers.set(handler.kind, handler);
    this.logger.log(`[PROPOSAL] kind ${handler.kind} registered`);
  }

  private handler(kind: ProposalKind): ProposalKindHandler {
    const handler = this.handlers.get(kind);
    if (!handler) throw new BadRequestException(`Unknown proposal kind ${kind}`);
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
    const handler = this.handler(kind);
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
      await handler.announce(saved, acceptorIds);
    } catch (e: unknown) {
      // The proposal is stored and sits in the queue whatever happens here; what a failure loses is
      // the notification, and this line is all that loss leaves.
      this.logger.warn(`[PROPOSAL] ${saved.id} stored but its acceptors were not told`, e);
    }
    return saved;
  }

  /** Accepts a pending proposal: the acceptor flag in the RECEIVING association. */
  async accept(proposalId: string, actorId: string, isGlobalAdmin: boolean): Promise<Proposal> {
    const proposal = await this.load(proposalId);
    const handler = this.handler(proposal.kind);
    await this.assertMay(actorId, proposal.toAssociationId, handler.acceptorFlag, isGlobalAdmin);
    let after: AfterCommit = () => Promise.resolve();
    const decided = await this.repo.manager.transaction(async (manager) => {
      const row = await this.decide(manager, proposal.id, 'accepted', actorId);
      after = await handler.apply(manager, row, actorId);
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
    await this.assertMay(actorId, proposal.toAssociationId, handler.acceptorFlag, isGlobalAdmin);
    const decided = await this.decide(this.repo.manager, proposal.id, 'refused', actorId);
    this.logger.log(`[PROPOSAL] ${decided.id.slice(0, 8)} refused by ${actorId.slice(0, 8)}`);
    return decided;
  }

  /** Withdraws a pending proposal: the sender flag in the SENDING association. */
  async withdraw(proposalId: string, actorId: string, isGlobalAdmin: boolean): Promise<Proposal> {
    const proposal = await this.load(proposalId);
    const handler = this.handler(proposal.kind);
    await this.assertMay(actorId, proposal.fromAssociationId, handler.senderFlag, isGlobalAdmin);
    const decided = await this.decide(this.repo.manager, proposal.id, 'withdrawn', actorId);
    this.logger.log(`[PROPOSAL] ${decided.id.slice(0, 8)} withdrawn by ${actorId.slice(0, 8)}`);
    return decided;
  }

  /**
   * The pending proposals an association's management page shows THIS caller: those it RECEIVED,
   * of the kinds whose acceptor flag the caller holds there, and those it SENT, of the kinds whose
   * sender flag they hold. 403 when they hold neither for any kind.
   */
  async listPending(
    associationId: string,
    actorId: string,
    isGlobalAdmin: boolean
  ): Promise<{ incoming: ProposalView[]; outgoing: ProposalView[] }> {
    const acceptKinds: ProposalKind[] = [];
    const sendKinds: ProposalKind[] = [];
    for (const handler of this.handlers.values()) {
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
      toName: string;
      toSlug: string;
      toLogoUrl: string | null;
    })[] = await this.repo.manager.query(
      `SELECT p.*, fa.name AS "fromName", fa.slug AS "fromSlug", fa."logoUrl" AS "fromLogoUrl",
              ta.name AS "toName", ta.slug AS "toSlug", ta."logoUrl" AS "toLogoUrl"
         FROM proposals p
         JOIN associations fa ON fa.id = p."fromAssociationId"
         JOIN associations ta ON ta.id = p."toAssociationId"
        WHERE p.status = 'pending'
          AND ((p."toAssociationId" = $1 AND p.kind = ANY($2::text[]))
            OR (p."fromAssociationId" = $1 AND p.kind = ANY($3::text[])))
        ORDER BY p."createdAt" ASC`,
      [associationId, acceptKinds, sendKinds]
    );
    const subjects = new Map<string, Record<string, unknown>>();
    for (const kind of new Set(rows.map((r) => r.kind))) {
      const described = await this.handler(kind).describe(
        rows.filter((r) => r.kind === kind).map((r) => r.subjectId)
      );
      for (const [id, subject] of described) subjects.set(`${kind}:${id}`, subject);
    }
    const view = (r: (typeof rows)[number]): ProposalView => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      subjectId: r.subjectId,
      subject: subjects.get(`${r.kind}:${r.subjectId}`) ?? null,
      from: { id: r.fromAssociationId, name: r.fromName, slug: r.fromSlug, logoUrl: r.fromLogoUrl },
      to: { id: r.toAssociationId, name: r.toName, slug: r.toSlug, logoUrl: r.toLogoUrl },
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

  private async load(proposalId: string): Promise<Proposal> {
    const proposal = await this.repo.findOne({ where: { id: proposalId } });
    if (!proposal) throw new NotFoundException('Proposal not found');
    return proposal;
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
}
