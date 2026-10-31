import type { IMlsService, UserGroupRow } from '$lib/mls-client/IMlsService';
import type { Conversation } from '$lib/types';
import { isChannelConversationId } from './channelCrypto';
import { readLocalMembership } from './eviction';
import { dropGroupState, type DroppableMlsService } from './dropGroupState';

/**
 * Whether a conversation row is NEVER-ADMITTED: this account followed an invitation link, the server
 * holds its seat as an ask no member has answered (`awaitingAdmission`), and this device was never in
 * the group (`pending`). Nothing in it was ever readable here, so it is neither an established
 * channel nor a conversation with a past to keep.
 *
 * `pending` is part of the fact, not a filter on it: a row that was ever `active` was admitted, and
 * the two demotions out of `active` clear the flag as they write `pending`.
 */
export function isNeverAdmitted(
  convo: Pick<Conversation, 'lifecycle' | 'awaitingAdmission'>
): boolean {
  return convo.awaitingAdmission === true && convo.lifecycle === 'pending';
}

/**
 * Brings each conversation row's `awaitingAdmission` to what the server's list says of THIS device's
 * seat (`deviceMembership.awaitingAdmission`), the one writer of the flag outside the demotions.
 *
 * A row the server says nothing about - an older server without the field, or no device row for
 * this device (`deviceMembership: null`) - is left as it is: "the server did not say" is not "not an
 * ask". An `active` row is never flagged: this device is in the group, so the person was admitted.
 *
 * @returns the keys whose flag changed, for the caller to persist.
 */
export function syncAdmissionFlags(
  conversations: Map<string, Conversation>,
  serverGroups: readonly UserGroupRow[]
): string[] {
  const changed: string[] = [];
  for (const g of serverGroups) {
    const convo = conversations.get(g.groupId);
    const said = g.deviceMembership?.awaitingAdmission;
    if (!convo || said === undefined) continue;
    const awaiting = said === true && convo.lifecycle !== 'active';
    if ((convo.awaitingAdmission === true) === awaiting) continue;
    conversations.set(g.groupId, { ...convo, awaitingAdmission: awaiting });
    changed.push(g.groupId);
  }
  return changed;
}

/**
 * Brings each restored conversation row's lifecycle to the MLS state the restore actually holds -
 * in memory only; the caller persists the keys it is given back.
 *
 * - an `active` row whose group is NOT held is demoted to `pending` (`demoted`): it cannot send, and
 *   the next connection asks for its re-admission. Admitted once, so never read as a never-admitted
 *   ask again;
 * - a `pending` row whose group IS held, and whose MEMBERSHIP reads `true`, is promoted to `active`
 *   (`promoted`): its "Sync" badge would otherwise stay for ever (DF5);
 * - a row - `active` OR `pending` - whose group is held but whose membership reads `false` is
 *   `pending`, and the evicted state under it is DROPPED (`awaiting`): the recovery then asks the
 *   server, whose answer ends it.
 *
 * AN `active` ROW OVER A GROUP THIS DEVICE IS OUT OF IS A PAIR NOTHING LOCAL CAN INTERPRET (review of
 * #2808). It is what a kill leaves between a merged Remove becoming durable and the row's own write -
 * two stores, and a checkpoint takes no lock against the commit path: a flush on backgrounding, a
 * structural checkpoint of another group, or one already running can each export the merged Remove
 * before the row is saved, whatever order the commit path issues its own writes in. The Remove may
 * be a real eviction or the first half of this device's own re-admission, and the in-memory record
 * that told them apart (`reAddIsInFlight`) died with the process. Kept `active`, the next send
 * recorded an eviction and retired a conversation the Welcome was about to give back; so the
 * restore no longer decides at all. The server does: a Welcome owed is waited for, a seat is joined,
 * NO seat retires the row (`stopRecovering`) - the right end for both readings of the Remove.
 *
 * WHY THE PROMOTION READS MEMBERSHIP AND NOT `getLocalGroups()` ALONE. An evicted
 * group stays held, and a `pending` row over a held group this device is out of is a re-admission
 * waiting for its Welcome - written by the client before 2026-10-31, which kept the evicted state
 * (`retireIfEvicted` now drops it). Promoted on held state, it became `active` over a group nothing
 * can be sent into, and the outbox then failed the next message as evicted and retired the
 * conversation the Welcome was about to give back (review, 2026-10-31). Kept as it was, nothing
 * would ever end the wait: `requestReAdd` and the watchdog both read a held group as needing nothing.
 * Dropped, it is the ordinary awaiting-Welcome state, which the recovery ends on the server's answer.
 * An unreadable membership (`null`) promotes and drops nothing; `readLocalMembership` logs it.
 */
export async function reconcileRestoredLifecycles(deps: {
  conversations: Map<string, Conversation>;
  localGroups: ReadonlySet<string>;
  mlsService: Pick<IMlsService, 'isGroupActive'> & DroppableMlsService;
  log: (message: string) => void;
}): Promise<{ demoted: string[]; promoted: string[]; awaiting: string[] }> {
  const { conversations, localGroups, mlsService, log } = deps;
  const demoted: string[] = [];
  const promoted: string[] = [];
  const awaiting: string[] = [];
  /** Rows over a held group, whose membership decides them. */
  const held: Array<{ key: string; groupId: string }> = [];
  for (const [key, c] of conversations.entries()) {
    if (isChannelConversationId(c.id)) continue;
    if (c.lifecycle === 'active' && !localGroups.has(c.id)) {
      conversations.set(key, { ...c, lifecycle: 'pending', awaitingAdmission: false });
      demoted.push(key);
    } else if (c.lifecycle !== 'removed' && localGroups.has(c.id)) {
      held.push({ key, groupId: c.id });
    }
  }
  // Read together: one local read per held row, and none of them waits on another.
  const memberships = await Promise.all(
    held.map(({ groupId }) =>
      readLocalMembership({ mlsService, groupId, context: 'while reconciling a restored row', log })
    )
  );
  for (const [i, { key, groupId }] of held.entries()) {
    const member = memberships[i];
    if (member === false) {
      const was = conversations.get(key)?.lifecycle;
      // Not under the MLS mutex, and the restore has not opened the session yet: awaited.
      await dropGroupState(mlsService, groupId, {
        reason: `a restored ${was ?? 'missing'} row over a group this device is out of - the server decides`,
        checkpoint: 'awaited',
        log,
      });
      // Re-read: the await above lets another writer touch the row.
      const now = conversations.get(key);
      if (now && now.lifecycle !== 'removed') {
        // An `active` row was admitted once, so it is never read as a never-admitted ask again.
        if (now.lifecycle === 'active') {
          conversations.set(key, { ...now, lifecycle: 'pending', awaitingAdmission: false });
        }
        awaiting.push(key);
      }
      continue;
    }
    if (member !== true) continue;
    const now = conversations.get(key);
    if (now?.lifecycle !== 'pending') continue;
    conversations.set(key, { ...now, lifecycle: 'active' });
    promoted.push(key);
  }
  return { demoted, promoted, awaiting };
}
