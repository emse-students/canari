import type { EntityManager } from 'typeorm';

/**
 * WHAT THE EVENT WRITE PATH ASKS OF CO-ORGANISATION (D39), stated here so `AssociationsService`
 * needs nothing from the module that implements it.
 *
 * Co-organisation is a proposal kind (`coorganisation/`), and that module imports this one - for
 * `mayAct` and the events - so this one cannot import it back without a cycle. The implementation
 * registers itself here at boot (`AssociationsService.registerCoOrganisers`), the same shape as a
 * proposal kind registering with `ProposalsService`.
 */
export interface CoOrganiserSyncRequest {
  eventId: string;
  /** The event's own association: the sender of every `coorganise` proposal. */
  organiserId: string;
  /** The co-organisers the form now names: accepted, pending, and newly added. */
  desiredIds: string[];
  actorId: string;
  isGlobalAdmin: boolean;
  /**
   * The actor writes the event as its ORGANISER: through the organiser's own route, as a BDE
   * validator governing it, or as a global admin. False when they write it through a co-organiser
   * association, which may then only remove ITSELF (leave).
   */
  organiserSide: boolean;
  /** The association the actor routed through (`:id` of the event route). */
  viaAssociationId: string;
}

/** What to run once the caller's transaction has COMMITTED (a rolled-back one never runs it). */
export type CoOrganiserAfterCommit = () => Promise<void>;

/** The co-organisation half the event write path calls. */
export interface CoOrganiserPort {
  /**
   * Turns the form's list into proposals: a new name is PROPOSED (no right, no reach until it
   * accepts), a pending one left out is WITHDRAWN, an accepted one left out is ENDED (its rights and
   * its audience go with its row). A refused one stays refused and is not proposed again.
   */
  sync(request: CoOrganiserSyncRequest, manager?: EntityManager): Promise<CoOrganiserAfterCommit>;
  /**
   * Every refusal `sync` can give (the cap, a partner changing more than its own presence), with NO
   * write. The event write calls it BEFORE its first write, so a refused request leaves nothing
   * behind - `sync` itself runs its writes last and re-checks, the same plan.
   */
  check(request: CoOrganiserSyncRequest, manager?: EntityManager): Promise<void>;
}
