import type { UserGroupRow } from '$lib/mls-client/IMlsService';
import type { Conversation } from '$lib/types';

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
