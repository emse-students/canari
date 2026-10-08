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
import { AssociationsService } from '../associations/associations.service';
import type { CoOrganiserPort, CoOrganiserSyncRequest } from '../associations/co-organisers.port';
import { AssociationCalendarEventCoOwner } from '../associations/entities/association-calendar-event-co-owner.entity';
import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';
import { PostNotificationsService } from '../posts/post-notifications.service';
import {
  ProposalsService,
  type AfterCommit,
  type ProposalKindHandler,
} from '../proposals/proposals.service';
import type { Proposal } from '../proposals/proposal.entity';

/** The state of one co-organiser of an event, as the event form draws it. */
export type CoOrganiserStatus = 'accepted' | 'pending' | 'refused';

/** One co-organiser of an event, with its state - what `GET .../co-organisers` returns. */
export interface CoOrganiserView {
  associationId: string;
  name: string;
  slug: string;
  color: string | null;
  logoUrl: string | null;
  status: CoOrganiserStatus;
  /** The proposal behind the state; null for an accepted row with none (should not exist after 074). */
  proposalId: string | null;
}

/** The columns of an event this service decides on. */
interface EventRow {
  id: string;
  associationId: string;
  title: string;
}

/**
 * EVENT CO-ORGANISATION BY PROPOSAL (D39, decided by the user on 2026-10-04).
 *
 * Naming another association as co-organiser ASKS it: a `coorganise` proposal (subject = the event)
 * on the generic proposals of migration 073. Until its publishers (`POST_AS_ASSO`, the repost rule,
 * no new grant) accept, it has NO right on the event and the event does not appear to its audience;
 * accepting writes its `association_calendar_event_co_owners` row, and that row is what both the
 * rights (`findCalendarEventForAssociation`) and the reach (`eventVisibleToUserSql`) read. No
 * expiry; the organiser withdraws a pending one; a refusal is recorded and stands; an accepted one
 * may leave, or be removed by the organiser, and the event's audience is recomputed without it on
 * the next read - the event itself stays with its organiser.
 *
 * Sender flag: `PROPOSE_EVENT` in the organiser, the right that writes its events.
 */
@Injectable()
export class CoorganisationService implements OnModuleInit, ProposalKindHandler, CoOrganiserPort {
  private readonly logger = new Logger(CoorganisationService.name);
  readonly kind = 'coorganise' as const;
  readonly senderFlag = AssociationPermissionFlag.PROPOSE_EVENT;
  readonly acceptorFlag = AssociationPermissionFlag.POST_AS_ASSO;

  constructor(
    @InjectRepository(AssociationCalendarEventCoOwner)
    private readonly coOwnerRepo: Repository<AssociationCalendarEventCoOwner>,
    private readonly associations: AssociationsService,
    private readonly notifications: PostNotificationsService,
    private readonly proposals: ProposalsService
  ) {}

  onModuleInit(): void {
    this.proposals.register(this);
    this.associations.registerCoOrganisers(this);
  }

  // ── The event form's list ──────────────────────────────────────────────────────────────────────

  /**
   * Every co-organiser of `eventId` with its state: accepted (a row), pending or refused (a
   * proposal). A withdrawn proposal is history and is not shown. Oldest first.
   */
  async listStates(eventId: string, manager?: EntityManager): Promise<CoOrganiserView[]> {
    const rows: (Omit<CoOrganiserView, 'status'> & { status: string })[] = await (
      manager ?? this.coOwnerRepo.manager
    ).query(
      `SELECT a.id AS "associationId", a.name, a.slug, a.color, a."logoUrl",
              'accepted'::text AS status, p.id AS "proposalId", 0 AS rank
         FROM association_calendar_event_co_owners co
         JOIN associations a ON a.id = co.association_id
         LEFT JOIN proposals p ON p.kind = 'coorganise' AND p."subjectId" = co.event_id
              AND p."toAssociationId" = co.association_id AND p.status = 'accepted'
        WHERE co.event_id = $1
       UNION ALL
       SELECT a.id, a.name, a.slug, a.color, a."logoUrl", p.status::text, p.id, 1
         FROM proposals p
         JOIN associations a ON a.id = p."toAssociationId"
        WHERE p.kind = 'coorganise' AND p."subjectId" = $1 AND p.status IN ('pending', 'refused')
        ORDER BY rank, name`,
      [eventId]
    );
    return rows.map((r) => ({
      associationId: r.associationId,
      name: r.name,
      slug: r.slug,
      color: r.color ?? null,
      logoUrl: r.logoUrl ?? null,
      status: r.status as CoOrganiserStatus,
      proposalId: r.proposalId ?? null,
    }));
  }

  /**
   * The states of `eventId`'s co-organisers for a caller who may WRITE the event through
   * `associationId` (the same rule as editing it: organiser, accepted co-organiser, BDE governing
   * it, global admin). 404 when the event is not reachable through that association.
   */
  async listStatesFor(
    associationId: string,
    eventId: string,
    actorId: string,
    isGlobalAdmin: boolean
  ): Promise<CoOrganiserView[]> {
    const tier = await this.associations.assertMayWriteEvent(
      actorId,
      isGlobalAdmin,
      associationId,
      eventId
    );
    const ev = await this.associations.findCalendarEventForAssociation(
      eventId,
      associationId,
      tier.isGlobalAdmin || tier.isBde
    );
    if (!ev) throw new NotFoundException('Event not found');
    return this.listStates(eventId);
  }

  /**
   * THE FORM'S LIST, TURNED INTO PROPOSALS (`CoOrganiserPort`). Computed against the current state,
   * so a form resubmitted unchanged changes nothing:
   * - a name neither accepted, pending nor refused is PROPOSED;
   * - a refused one is NOT proposed again (the refusal stands; logged);
   * - a pending one left out is WITHDRAWN;
   * - an accepted one left out is ENDED: its row (rights, reach) goes, its proposal is moved to
   *   `withdrawn` so the pair may be asked again later.
   * A caller writing through a CO-ORGANISER association may only remove that association itself
   * (leave); anything else is a 403 BEFORE any write.
   */
  async sync(request: CoOrganiserSyncRequest): Promise<void> {
    const { eventId, organiserId, actorId } = request;
    const states = await this.listStates(eventId);
    const byId = new Map(states.map((s) => [s.associationId, s]));
    const desired = new Set(request.desiredIds.filter((id) => id && id !== organiserId));
    const toPropose = [...desired].filter((id) => !byId.has(id));
    const refusedAgain = [...desired].filter((id) => byId.get(id)?.status === 'refused');
    const toEnd = states.filter((s) => s.status !== 'refused' && !desired.has(s.associationId));
    this.logger.debug(
      `[COORG] sync ${eventId.slice(0, 8)} by ${actorId.slice(0, 8)} (organiserSide=${request.organiserSide}): ` +
        `propose=${toPropose.length} end=${toEnd.length} refusedAgain=${refusedAgain.length}`
    );
    if (refusedAgain.length > 0) {
      this.logger.log(
        `[COORG] ${eventId.slice(0, 8)}: ${refusedAgain.length} refused co-organiser(s) not asked again`
      );
    }
    if (!request.organiserSide) {
      const onlyLeaving =
        toPropose.length === 0 && toEnd.every((s) => s.associationId === request.viaAssociationId);
      if (!onlyLeaving) {
        this.logger.debug(
          `[COORG] ${actorId.slice(0, 8)} via co-organiser ${request.viaAssociationId.slice(0, 8)} may only leave`
        );
        throw new ForbiddenException('A co-organiser may only remove itself');
      }
    }
    if (toEnd.length > 0) {
      await this.coOwnerRepo.manager.transaction(async (manager) => {
        for (const state of toEnd) {
          await this.end(manager, eventId, state, actorId);
        }
      });
    }
    for (const toAssociationId of toPropose) {
      // The event write check already established that the actor speaks for the organiser.
      await this.proposals.propose(
        this.kind,
        eventId,
        toAssociationId,
        actorId,
        request.isGlobalAdmin,
        { senderVouched: true }
      );
    }
  }

  /** Withdraws a pending co-organiser, or ends an accepted one, inside `manager`'s transaction. */
  private async end(
    manager: EntityManager,
    eventId: string,
    state: CoOrganiserView,
    actorId: string
  ): Promise<void> {
    if (state.status === 'pending') {
      await this.proposals.withdrawBySubject(
        manager,
        this.kind,
        eventId,
        state.associationId,
        'pending',
        actorId
      );
      return;
    }
    await manager.query(
      `DELETE FROM association_calendar_event_co_owners WHERE event_id = $1 AND association_id = $2`,
      [eventId, state.associationId]
    );
    const ended = await this.proposals.withdrawBySubject(
      manager,
      this.kind,
      eventId,
      state.associationId,
      'accepted',
      actorId
    );
    if (!ended) {
      // Every row has a proposal after migration 074; one without means a row written by a path
      // that skipped the proposal, and that is what this line accuses.
      this.logger.warn(
        `[COORG] co-owner ${state.associationId} of ${eventId} ended with no accepted proposal behind it`
      );
    }
    this.logger.log(
      `[COORG] ${state.associationId.slice(0, 8)} no longer co-organises ${eventId.slice(0, 8)} (by ${actorId.slice(0, 8)})`
    );
  }

  // ── The `coorganise` proposal kind ─────────────────────────────────────────────────────────────

  async resolveSender(eventId: string, toAssociationId: string): Promise<string> {
    const ev = await this.loadEvent(eventId);
    if (!ev) {
      this.logger.debug(`[COORG] ${eventId.slice(0, 8)} refused: no such event`);
      throw new NotFoundException('Event not found');
    }
    if (ev.associationId === toAssociationId) {
      throw new BadRequestException('An event is already organised by its own association');
    }
    const target: unknown[] = await this.coOwnerRepo.manager.query(
      `SELECT 1 FROM associations WHERE id = $1`,
      [toAssociationId]
    );
    if (target.length === 0) throw new NotFoundException('Association not found');
    const existing: unknown[] = await this.coOwnerRepo.manager.query(
      `SELECT 1 FROM association_calendar_event_co_owners WHERE event_id = $1 AND association_id = $2`,
      [eventId, toAssociationId]
    );
    if (existing.length > 0) {
      throw new ConflictException('This association already co-organises this event');
    }
    return ev.associationId;
  }

  async apply(manager: EntityManager, proposal: Proposal, actorId: string): Promise<AfterCommit> {
    const ev = await this.loadEvent(proposal.subjectId, manager);
    if (!ev) {
      // The trigger of 074 removes the proposals of a deleted event, so this is a race lost to a
      // deletion; the acceptance rolls back with the transaction.
      throw new NotFoundException('Event not found');
    }
    await manager.query(
      `INSERT INTO association_calendar_event_co_owners (id, event_id, association_id)
         VALUES (gen_random_uuid(), $1, $2) ON CONFLICT (event_id, association_id) DO NOTHING`,
      [ev.id, proposal.toAssociationId]
    );
    this.logger.log(
      `[COORG] ${proposal.toAssociationId.slice(0, 8)} now co-organises ${ev.id.slice(0, 8)} (accepted by ${actorId.slice(0, 8)})`
    );
    return () => Promise.resolve();
  }

  async announce(proposal: Proposal, acceptorIds: string[]): Promise<void> {
    const [from, ev] = await Promise.all([
      this.loadAssociation(proposal.fromAssociationId),
      this.loadEvent(proposal.subjectId),
    ]);
    if (!from || !ev) {
      this.logger.warn(
        `[COORG] proposal ${proposal.id} cannot be announced: association or event gone`
      );
      return;
    }
    // `postId` CARRIES THE RECEIVING ASSOCIATION, as `repost_proposed` does: the acceptor opens its
    // queue, and a pending co-organisation gives them nothing to open on the agenda yet.
    const count = await this.notifications.createNotifications({
      recipientIds: acceptorIds,
      type: 'coorganise_proposed',
      postId: proposal.toAssociationId,
      actorId: proposal.proposedBy,
      actorName: from.name,
      associationId: from.id,
      associationLogoUrl: from.logoUrl,
      associationLogoMediaId: from.logoMediaId,
      text: ev.title,
      // The tap opens the receiving association's queue, not the feed.
      pushData: { queueAssociationId: proposal.toAssociationId },
    });
    this.logger.log(`[COORG] proposal ${proposal.id.slice(0, 8)} announced to ${count}`);
  }

  async describe(eventIds: string[]): Promise<Map<string, Record<string, unknown>>> {
    if (eventIds.length === 0) return new Map();
    const rows: {
      id: string;
      title: string;
      startsAt: Date;
      endsAt: Date | null;
      associationName: string | null;
    }[] = await this.coOwnerRepo.manager.query(
      `SELECT e.id, e.title, e."startsAt", e."endsAt", a.name AS "associationName"
         FROM association_calendar_events e LEFT JOIN associations a ON a.id = e."associationId"
        WHERE e.id = ANY($1::uuid[])`,
      [eventIds]
    );
    return new Map(
      rows.map((r) => [
        r.id,
        {
          title: r.title,
          startsAt: r.startsAt,
          endsAt: r.endsAt,
          associationName: r.associationName,
        },
      ])
    );
  }

  // ── Reads ──────────────────────────────────────────────────────────────────────────────────────

  private async loadEvent(eventId: string, manager?: EntityManager): Promise<EventRow | null> {
    const rows: EventRow[] = await (manager ?? this.coOwnerRepo.manager).query(
      `SELECT id, "associationId", title FROM association_calendar_events WHERE id = $1`,
      [eventId]
    );
    return rows[0] ?? null;
  }

  private async loadAssociation(id: string) {
    const rows: { id: string; name: string; logoUrl: string | null; logoMediaId: string | null }[] =
      await this.coOwnerRepo.manager.query(
        `SELECT id, name, "logoUrl", "logoMediaId" FROM associations WHERE id = $1`,
        [id]
      );
    return rows[0] ?? null;
  }
}
