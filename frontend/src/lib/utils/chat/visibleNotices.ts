/**
 * A VISIBLE NOTICE - "X added Y", "X renamed the group", "X changed the photo", "X removed Y" - IS ONE
 * ROW, UNDER ONE ID, ON EVERY DEVICE OF EVERY MEMBER, THE ACTING DEVICE INCLUDED.
 *
 * Every other device writes the row from the frame it receives (`systemMessageHandler.ts` live,
 * `historySystemEvents.ts` from the archive), under the id the sender minted (`mkVisibleSystem`).
 * MLS never hands a device its own application message, so the ACTING device never received one:
 * it held no row, its history state key differed from every other member's, the reconciliation's
 * diff relayed the notice back, and the device marked it unverified - a row authored by nobody
 * cannot carry an author proof. Writing it here, under the SAME minted id, once the frame is
 * accepted, is the primary path the channel invitation card already takes
 * (`inviteMemberToChannel`): every device then holds the same row and there is nothing to relay.
 *
 * `renderVisibleNotice` is the ONE rendering of these four events, used by the acting device, the
 * live handler and the archive replay, so the three cannot draw the same event differently.
 *
 * @see docs/wiki/protocols/history-reconciliation.md#the-acting-device-writes-its-own-notice
 */
import { m } from '$lib/paraglide/messages';
import type { IMlsService } from '$lib/mlsService';
import { encodeAppMessage, mkVisibleSystem } from '$lib/proto/codec';
import type { AddMessageToChatOptions } from '$lib/types';
import { resolveDisplayNames } from '$lib/utils/users/displayName';
import { SYSTEM_SENDER_ID } from './messageUtils';

/** The visible events whose notice every member's device draws, the actor's included. */
export type VisibleNoticeEvent =
  | 'memberAdded'
  | 'memberRemoved'
  | 'groupRenamed'
  | 'groupImageChanged';

/** Writes a row into a conversation - `addMessageToChat`, as every caller already holds it. */
export type NoticeWriter = (
  senderId: string,
  content: string,
  contactName: string,
  options?: AddMessageToChatOptions
) => Promise<void>;

/** Where the acting device writes its own copy of a notice. */
export interface OwnNotice {
  /** The conversation's key in the conversations map. */
  contactName: string;
  /** The acting user, as the receivers will read the frame's sender. */
  actor: string;
  addMessageToChat: NoticeWriter;
}

/** The users a `memberAdded` payload names, in either shape a sender has written. */
function addedUsersOf(data: Record<string, unknown>): string[] {
  if (Array.isArray(data.newUsers)) return data.newUsers.map(String);
  return data.newUser ? [String(data.newUser)] : [];
}

/**
 * The text of a visible notice, or `null` when its payload names nothing to draw (a rename with no
 * name, a removal with no target, an addition of nobody) - the same verdicts the receivers apply.
 */
export async function renderVisibleNotice(
  event: VisibleNoticeEvent,
  data: Record<string, unknown>,
  actor: string
): Promise<string | null> {
  switch (event) {
    case 'groupRenamed': {
      if (!data.newName) return null;
      const getName = await resolveDisplayNames([actor]);
      return m.chat_system_group_renamed({ sender: getName(actor), name: String(data.newName) });
    }
    case 'groupImageChanged': {
      const getName = await resolveDisplayNames([actor]);
      const imageMediaId =
        typeof data.imageMediaId === 'string' && data.imageMediaId ? data.imageMediaId : null;
      return imageMediaId
        ? m.chat_system_group_photo_changed({ sender: getName(actor) })
        : m.chat_system_group_photo_removed({ sender: getName(actor) });
    }
    case 'memberRemoved': {
      if (!data.targetUser) return null;
      const target = String(data.targetUser);
      const getName = await resolveDisplayNames([actor, target]);
      return m.chat_system_member_removed({ sender: getName(actor), target: getName(target) });
    }
    case 'memberAdded': {
      const users = addedUsersOf(data);
      const getName = await resolveDisplayNames([actor, ...users]);
      const added = users.map((u) => getName(u)).join(', ');
      return added ? m.chat_system_member_added({ sender: getName(actor), members: added }) : null;
    }
  }
}

/**
 * Sends a visible notice frame and, once the delivery service has ACCEPTED it, writes the acting
 * device's own row under the id the frame carries.
 *
 * The text is rendered BEFORE the send and the row written right after it, so nothing slow sits
 * between the send and whatever the caller does next (an MLS checkpoint follows the `memberAdded`
 * send). The row is written only once the send resolved: a frame that never left reaches no member,
 * and a row only this device holds is the same divergence in the other direction. A failed SEND
 * throws to the caller, which owns what a lost notice means for its action (all of them go on
 * without it). A failed LOCAL WRITE is a different fact - the members have the notice, this device
 * does not - so it is logged here under its own line and never thrown as a send failure.
 *
 * `own` is absent where the acting user's devices deliberately draw nothing - a departure or a
 * deletion, whose conversation this device is about to drop - so no device of that user holds the
 * row and there is still nothing to diverge.
 */
export async function sendVisibleNotice(
  mlsService: IMlsService,
  groupId: string,
  event: VisibleNoticeEvent | 'memberLeft' | 'groupDeleted',
  payload: Record<string, unknown>,
  own?: OwnNotice
): Promise<void> {
  const frame = mkVisibleSystem(event, JSON.stringify(payload));
  const noOwnRow = event === 'memberLeft' || event === 'groupDeleted' || !own;
  const text = noOwnRow ? null : await renderVisibleNotice(event, payload, own.actor);
  await mlsService.sendMessage(groupId, encodeAppMessage(frame));
  if (noOwnRow) return;
  if (text === null) {
    console.warn(
      `[NOTICE] ${event} sent in ${groupId.slice(0, 8)}… names nothing to draw - no row written here, and none on the members' devices`
    );
    return;
  }
  try {
    await own.addMessageToChat(SYSTEM_SENDER_ID, text, own.contactName, {
      isSystem: true,
      messageId: frame.messageId,
      timestamp: new Date(frame.sentAt),
    });
  } catch (e) {
    console.error(
      `[NOTICE] ${event} was DELIVERED in ${groupId.slice(0, 8)}… but this device's own row ${frame.messageId.slice(0, 8)} was not written - the members hold it and this device does not: ${String(e).slice(0, 120)}`
    );
    return;
  }
  console.debug(
    `[NOTICE] ${event} written on the acting device in ${groupId.slice(0, 8)}… as ${frame.messageId.slice(0, 8)} - the id every member's device writes`
  );
}
