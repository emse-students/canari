/**
 * WHAT A MEMBERSHIP'S END ASKS OF THE LYDIA CASHIERS (review of the 1.7.1 flip of the cashier gate),
 * stated here so `AssociationsService` needs nothing from the service that implements it:
 * `LydiaCashiersService` depends on `AssociationsService` (membership), so it registers itself at
 * boot (`AssociationsService.registerCashierDepartures`), the shape `co-organisers.port.ts` uses.
 *
 * THE DEBT IS DURABLE STATE, NOT A JOB: a live `lydia_cashiers` row whose person holds no
 * `association_members` row of that association owes the removal of its numbers at Lydia (the
 * Responsable's current number excepted). Nothing is queued and no timer runs; the two triggers below
 * read that state and are safe to repeat, so a crash between the departure and the removal loses
 * nothing - the next read finds the same debt. Re-joining ends it by the same predicate.
 */
export interface LydiaCashierDeparturePort {
  /**
   * Removes, through the verified removal path, every number association `associationId` owes for
   * cashiers who are no longer members. NEVER throws and never blocks the caller's write: every
   * outcome is logged and recorded on the row (confirmed: closed; not confirmed: flagged), and
   * whatever could not be attempted stays owed for the next trigger.
   *
   * `departure`: a membership just ended (`removeMember`, which leaving goes through).
   * `payout-read`: a payout manager opened the payments card, which draws the debt.
   */
  settleDepartures(associationId: string, trigger: LydiaCashierDepartureTrigger): Promise<void>;
}

/** What asked for a departure's removal - logged, and decides whether a kept Responsable is told again. */
export type LydiaCashierDepartureTrigger = 'departure' | 'payout-read';
