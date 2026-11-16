/**
 * THE MEMBERSHIP NOTICE OF A SALON, AS IT TRAVELS AND AS IT IS READ.
 *
 * A channel has no per-event handler, so its notice is decoded where the message is. It used to
 * travel as an already-localized SENTENCE in `system.data` (the inviter's language, the names as the
 * inviter's device knew them, frozen into the frame forever). It now travels as the same JSON ids
 * a group's `memberAdded` carries (`{ "newUsers": [id] }`), and every reader draws the row with the
 * ONE rendering (`visibleNoticeContent`), names resolved at read time.
 *
 * **Two shapes live in the archive and on the wire, and the data itself tells them apart**: a JSON
 * object is the id shape, anything else is a legacy sentence from a build older than this one,
 * wrapped as it always was. The old shape stays READABLE forever (rows are never rewritten).
 *
 * **The reader ships before the writer.** A build older than this reader draws `system.data` as text,
 * so an id frame would reach its screen as raw `{"newUsers":[...]}`. Every supported build must read
 * the id shape before any build sends it: {@link CHANNEL_NOTICE_IDS_WRITER_ENABLED}.
 *
 * @see docs/wiki/frontend/modules/chat.md
 */
import type { IAppMessage } from '$lib/proto/codec';
import { m } from '$lib/paraglide/messages';
import { resolveDisplayNames } from '$lib/utils/users/displayName';
import { appMsgToChannelSystemEnvelope } from './messageUtils';
import { visibleNoticeContent, type VisibleNoticeEvent } from './visibleNotices';

type ChannelEnvelope = ReturnType<typeof appMsgToChannelSystemEnvelope>;

/**
 * THE WRITER FLIP - `false`, AND `false` IS THE WHOLE OF ITS SAFETY.
 *
 * While it is `false` a salon invitation sends the sentence every build draws; the reader above
 * reads both shapes. The flip is THIS ONE LINE, and it lands only when `minClientVersion` is at or
 * above the first stable carrying this reader (`1.7.0`), read on BOTH estates - the floor rule of
 * docs/wiki/legacy-compatibility.md ("a salon invitation notice"), planned in
 * docs/wiki/backlog.d/a-salon-invitation-notice-sends-ids-once-the-floor-reads-them.md. A compile-time
 * fact of the binary, no server read: a build at the floor never receives a shape it cannot draw.
 */
export const CHANNEL_NOTICE_IDS_WRITER_ENABLED = false;

/**
 * The `system.data` a salon invitation's `memberAdded` frame carries: the ids once the writer is on,
 * else the sentence in the inviter's language (the legacy shape every supported build draws).
 *
 * @param writesIds the switch, injectable for the test of both shapes
 */
export async function channelMemberAddedData(
  memberId: string,
  inviterId: string,
  writesIds: boolean = CHANNEL_NOTICE_IDS_WRITER_ENABLED
): Promise<string> {
  if (writesIds) return JSON.stringify({ newUsers: [memberId] });
  const nameOf = await resolveDisplayNames([memberId, inviterId]);
  return m.chat_system_member_added({ sender: nameOf(inviterId), members: nameOf(memberId) });
}

/** The events a salon's id-shaped notice may carry - today only an addition. */
const CHANNEL_NOTICE_EVENTS: readonly VisibleNoticeEvent[] = ['memberAdded'];

/**
 * Classifies a salon notice's `data` AT THE SOURCE: the id payload when it is a JSON object, else
 * `null` (a legacy sentence). A sentence never starts with `{`, so no sentence is mistaken for ids.
 */
export function channelNoticePayload(data: string): Record<string, unknown> | null {
  if (!data.trimStart().startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(data);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // Starts like an object and is not one: a broken id frame, never a sentence a person wrote.
    return null;
  }
}

/**
 * The stored content and dating of a salon system frame, or `null` when it draws nothing.
 *
 * @param actorId the frame's author as the row proves it (the ROW's sender, never a payload field)
 */
export async function channelSystemEnvelope(
  msg: IAppMessage,
  serverFallbackMs: number | undefined,
  actorId: string
): Promise<ChannelEnvelope> {
  const legacy = appMsgToChannelSystemEnvelope(msg, serverFallbackMs);
  const event = msg.system?.event ?? '';
  const payload = channelNoticePayload(msg.system?.data ?? '');
  if (!legacy || !payload) return legacy;
  if (!CHANNEL_NOTICE_EVENTS.includes(event as VisibleNoticeEvent)) {
    console.warn(`[CHANNEL_NOTICE] '${event}' carries ids but is no salon notice - nothing drawn`);
    return null;
  }
  const content = await visibleNoticeContent(event as VisibleNoticeEvent, payload, actorId);
  if (content === null) {
    console.warn(
      `[CHANNEL_NOTICE] '${event}' from ${actorId.slice(0, 8)} names nobody - nothing drawn`
    );
    return null;
  }
  return { content, options: legacy.options };
}
