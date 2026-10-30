import type {
  DeviceMembershipRow,
  DistributionSeat,
  UserGroupRow,
} from '$lib/mls-client/IMlsService';

/**
 * What this device's membership row says about the ONE question that picks a door into a group:
 * is somebody else about to Welcome me, or must I serve myself?
 *
 * - `welcome-queued`: the row is `pending` and a Welcome sits in THIS device's own mailbox. It is
 *   waited for, and the mailbox is the place to look - not a member (`requestReAdd`).
 * - `add-in-flight`: `pending`, no Welcome queued, and SOME member holds the group's add lock right
 *   now. The lock is per group, so it does not say the Add is for this device; it says an Add may be,
 *   and serving itself an external commit inside that window is the GRP-4 duplicate-leaf race of
 *   2026-08-26. The device WAITS; the next read after the lock is released decides.
 * - `unhonoured-seat`: `pending` with no queued Welcome and no add in flight - a roster seat nothing
 *   follows. Nobody owes the device anything, so it may serve itself.
 * - `not-pending`: no row, or an `active` one (joined once, state since lost). The self-service
 *   door is the device's own.
 * - `awaiting-admission`: the seat came from an invitation link and no member has admitted the
 *   person yet (`awaitingAdmission`). The self-service door is SHUT - the server refuses this person
 *   the base and every commit - and a new person enters only by a member's Add (decided 2026-10-23,
 *   docs/wiki/protocols/mls-protocol.md, "Who admits a new person"). So the device asks a member,
 *   and the member it reaches is shown the ask. It wins over every other fact of a row that is not
 *   `active`; an `active` row is in the tree - a Welcome admitted it - so the flag says nothing
 *   there and the row reads `not-pending`.
 *
 * THE TWO FACTS ARE TWO READINGS (DUP-2 review, 2026-10-25), because they send the device to two
 * different places: a queued Welcome is in its own mailbox, an add lock is somebody else's work. They
 * used to be one `owed`, and a caller could act on neither specifically.
 *
 * ONE READING FOR EVERY DOOR THAT ASKS IT, and there are two: the conversation recovery seam
 * (`requestReAdd`) and the Graine key-group join (`ensureDistributionGroupFor`), which since
 * 2026-09-27 can also be entered by an admitter's Welcome (channel-encryption section 20). The
 * full reasoning behind `welcomeQueued` / `addInFlight` is on {@link DeviceMembershipRow} and on
 * `getDeviceMemberships` in `apps/chat-delivery-service/src/controllers/invitations.controller.ts`.
 */
export type WelcomeOwedReading =
  | 'welcome-queued'
  | 'add-in-flight'
  | 'awaiting-admission'
  | 'unhonoured-seat'
  | 'not-pending';

/** The readings in which somebody else's Welcome is the door, so the device joins nothing itself. */
export function isWelcomeOwed(reading: WelcomeOwedReading): boolean {
  return reading === 'welcome-queued' || reading === 'add-in-flight';
}

/**
 * Classifies one membership row; see {@link WelcomeOwedReading}. PURE.
 *
 * `null` WHEN A `pending` ROW DOES NOT ANSWER: it carries neither `welcomeQueued` nor
 * `addInFlight`. Every deployed server has written both since 2026-09-03
 * (`getDeviceMemberships`), so such a row is an anomaly, not an old server to be humoured - it is
 * the same "could not be read" a thrown request is, and each caller already skips its pass on that
 * and says so at a level that accuses. It used to be a reading of its own (`pending-unqualified`),
 * waited on like an owed Welcome; nothing produced it.
 *
 * `ignoreQueuedWelcome` is for a caller that has just HANDLED a Welcome for this group and failed to
 * join from it (`NoMatchingKeyPackage`, `GroupAlreadyExists`): its ACK may not have reached the server
 * yet, so the row can still list that very Welcome as queued, and reading it as owed would make the
 * device wait for the Welcome it has already spent. It reads past EVERY queued Welcome of the group,
 * the spent one and any other; that is safe because the door it opens is guarded where it acts - an
 * external join stands down under the MLS lock when a Welcome installed the group first
 * (`externalJoin`), and one that lands first replaces the leaf an Add wrote for the same key
 * (`mls-core/tests/external_join.rs`).
 */
export function readWelcomeOwedFromRow(
  row: DeviceMembershipRow | undefined,
  opts: { ignoreQueuedWelcome?: boolean } = {}
): WelcomeOwedReading | null {
  if (row?.awaitingAdmission === true && row.status !== 'active') return 'awaiting-admission';
  if (row?.status !== 'pending') return 'not-pending';
  if (row.welcomeQueued === undefined || row.addInFlight === undefined) return null;
  if (row.welcomeQueued === true && !opts.ignoreQueuedWelcome) return 'welcome-queued';
  if (row.addInFlight === true) return 'add-in-flight';
  return 'unhonoured-seat';
}

/**
 * Classifies a key-group seat served WITH its base ({@link DistributionSeat}) in the same terms as
 * {@link readWelcomeOwedFromRow}. PURE.
 *
 * `null` when there is nothing to read: no seat served, or a `pending` seat whose add lock could not
 * be read (`addInFlight` absent). That is "unknown", and it opens no door - reading it as
 * `unhonoured-seat` would let a device join over an Add in flight.
 */
export function readWelcomeOwedFromSeat(
  seat: DistributionSeat | undefined
): WelcomeOwedReading | null {
  if (!seat) return null;
  if (seat.status !== 'pending') return 'not-pending';
  if (seat.welcomeQueued) return 'welcome-queued';
  if (seat.addInFlight === undefined) return null;
  return seat.addInFlight ? 'add-in-flight' : 'unhonoured-seat';
}

/**
 * Whether a group this device HOLDS the tree for is one the server has given it only a roster seat
 * for - `pending` with no Welcome queued, no add in flight and no admitting commit - read off the row
 * `GET /mls/users/:id/groups` already returned.
 *
 * THE SILENT-READER HALF OF `recoverRosterDisagreement`, which is entered by a refused send. Every
 * fact must be an explicit `false`: a server that does not say (`deviceMembership` absent or a field
 * undefined) is not a server saying nobody owes this device anything, and a device in its first
 * seconds after a legitimate add has a Welcome queued, the add lock held, or `admitted` set - so it
 * is never mistaken for stranded. A device that does NOT hold the tree is the other seam's
 * (`onGroupMissing`). PURE.
 */
export function isStrandedSeat(row: UserGroupRow, holdsTree: boolean): boolean {
  if (!holdsTree) return false;
  const seat = row.deviceMembership;
  if (!seat || seat.status !== 'pending') return false;
  return seat.welcomeQueued === false && seat.addInFlight === false && seat.admitted === false;
}
