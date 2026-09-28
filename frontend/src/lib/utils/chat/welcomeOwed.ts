import type { DeviceMembershipRow } from '$lib/mls-client/IMlsService';

/**
 * What this device's membership row says about the ONE question that picks a door into a group:
 * is somebody else about to Welcome me, or must I serve myself?
 *
 * - `owed`: the row is `pending` and a Welcome is queued for it, or a member holds the group's
 *   add-lock right now. Serving itself an external commit here is the GRP-4 duplicate-leaf race of
 *   2026-08-26 - two parties writing this device's leaf - so the device WAITS for the Welcome.
 * - `unhonoured-seat`: `pending` with no queued Welcome and no add in flight - a roster seat nothing
 *   follows. Nobody owes the device anything, so it may serve itself.
 * - `not-pending`: no row, or an `active` one (joined once, state since lost). The self-service
 *   door is the device's own.
 *
 * ONE READING FOR EVERY DOOR THAT ASKS IT, and there are two: the conversation recovery seam
 * (`requestReAdd`) and the Graine key-group join (`ensureDistributionGroupFor`), which since
 * 2026-09-27 can also be entered by an admitter's Welcome (channel-encryption section 20). The
 * full reasoning behind `welcomeQueued` / `addInFlight` is on {@link DeviceMembershipRow} and on
 * `getDeviceMemberships` in `apps/chat-delivery-service/src/controllers/invitations.controller.ts`.
 *
 * **A SERVER THAT DOES NOT SAY IS NOT A SERVER SAYING NO**: a `pending` row carrying neither field
 * reads `owed`, the behaviour every client had before the fields existed.
 */
export type WelcomeOwedReading = 'owed' | 'unhonoured-seat' | 'not-pending';

/** Classifies one membership row; see {@link WelcomeOwedReading}. PURE. */
export function readWelcomeOwedFromRow(row: DeviceMembershipRow | undefined): WelcomeOwedReading {
  if (row?.status !== 'pending') return 'not-pending';
  if (row.welcomeQueued === undefined && row.addInFlight === undefined) return 'owed';
  return row.welcomeQueued === true || row.addInFlight === true ? 'owed' : 'unhonoured-seat';
}
