/**
 * The three questions "can I use this group?" decomposes into, named once each.
 *
 * They were not named, and that is what this module is for. `getLocalGroups().includes(id)` was
 * written out by hand at NINETEEN call sites across eleven files; every one of them was asking the
 * same thing and asking it correctly, but there was no name to grep for, no place to hang the
 * caveat, and the caveat lived in exactly one doc comment on a DIFFERENT method
 * (`IMlsService.isGroupActive`) that none of the nineteen mention.
 *
 * ## The three, and why they are not interchangeable
 *
 * 1. **Does this device hold the state** - {@link holdsGroupState}. There is a group object in WASM
 *    or in the native manager. It decides whether an operation can be ATTEMPTED at all.
 * 2. **Is this device still a member** - `IMlsService.isGroupActive`, async, and it THROWS when the
 *    group is not held: never-joined and removed-from are opposite facts. It is false exactly when a
 *    Remove commit named our own leaf. **Question 1 stays TRUE after such an eviction** - the state
 *    is still held, it is simply no longer usable - and reading one as the other is what let the
 *    outbox retry an evicted group until its entries expired.
 * 3. **May an application message be encrypted right now** - {@link canSendInGroup}: question 1 AND
 *    no unresolved epoch gap. Held state that lags behind the group's epoch encrypts to an epoch the
 *    up-to-date members cannot read.
 *
 * ## Why free functions rather than methods on `IMlsService`
 *
 * Both are DERIVED from `getLocalGroups()` and need no platform knowledge, so as methods they would
 * be a second knob a mock can set independently - and a mock whose `getLocalGroups` and
 * `holdsGroupState` disagree is precisely the confusion these names exist to prevent. As free
 * functions there is one source of truth by construction, and the interface stays as wide as the
 * platforms actually make it.
 */

import type { IMlsService } from '$lib/mls-client/IMlsService';
import { isInEpochGap } from './epochGapRegistry';

/**
 * Whether this device holds local MLS state for `groupId` - question 1 above, and the NARROWEST of
 * the three. Synchronous, and it never throws.
 *
 * It does NOT mean the group is usable: it stays true for a group this device has been evicted from
 * (question 2) and for one whose state lags behind the current epoch (question 3).
 */
export function holdsGroupState(
  mlsService: Pick<IMlsService, 'getLocalGroups'>,
  groupId: string
): boolean {
  return mlsService.getLocalGroups().includes(groupId);
}

/**
 * Whether an application message may be encrypted for `groupId` RIGHT NOW - question 3, the only one
 * that composes two facts.
 *
 * Neither half is enough on its own. {@link holdsGroupState} alone would send a message encrypted at
 * a stale epoch, which the up-to-date members cannot decrypt - so the outbox must HOLD it instead.
 * `isInEpochGap` alone would pass a group we hold nothing for, because a group with no local state
 * has no epoch to be behind and therefore reads as "no gap".
 *
 * It was written inline in the session layer as `isGroupHealthy` and had exactly one caller; the
 * second caller would have re-derived it, and two facts are easy to compose wrongly.
 */
export function canSendInGroup(
  mlsService: Pick<IMlsService, 'getLocalGroups'>,
  groupId: string
): boolean {
  return holdsGroupState(mlsService, groupId) && !isInEpochGap(groupId);
}
