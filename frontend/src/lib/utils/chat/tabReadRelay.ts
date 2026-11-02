import type { TabMessageEvent } from '$lib/mls-client/tabMessageSync';
import type { ChatMessage, ReadWatermarks } from '$lib/types';
import { Log } from '$lib/utils/Log';
import { withOwnReadAdvanced, withRelayedReadState } from './readState';

/** The fields of a conversation the read events of the tab channel touch. */
type ReadConversation = {
  messages: Array<
    Pick<ChatMessage, 'isOwn' | 'isSystem' | 'senderId' | 'timestamp' | 'serverTimestamp'>
  >;
  lastMessageAt?: number;
  unreadCount?: number;
  readWatermarks?: ReadWatermarks;
  serverReadWatermarks?: ReadWatermarks;
};

/**
 * APPLIES THE READ EVENTS OF THE TAB CHANNEL to this tab's conversations - the half of the channel
 * that carries read state rather than messages. Pure: the store, the account and the "is this tab
 * reading that conversation" fact are all handed in, so the two-device tests drive it directly.
 *
 * - `conversation_read` (from ANY tab): a reading carries its mark, which advances this tab's own
 *   watermark and lets the count follow it; a selection carries none and zeroes the badge only when
 *   nothing newer than what that tab saw has arrived here since.
 * - `read_state` (from the LEADER): every mark the leader holds after a received event, merged by
 *   `max`; this account's own mark brings the count down with it.
 * - `unread_counts` (from the LEADER): the salon counts a server answer moved, except the salon this
 *   tab is reading, whose count its own receipt effect owns.
 *
 * @param me this tab's account.
 * @param isReading whether this tab is READING the conversation now (`isReadingConversationNow`).
 * @returns `true` when the event is one of the three (handled, even if it changed nothing), `false`
 *          for any other event, which the caller handles.
 */
export function applyTabReadEvent<C extends ReadConversation>(
  conversations: Map<string, C>,
  event: TabMessageEvent,
  me: string,
  isReading: (conversationKey: string) => boolean
): boolean {
  if (event.type === 'conversation_read') {
    const target = conversations.get(event.conversationId);
    if (!target) return true;
    if (event.mark) {
      const next = withOwnReadAdvanced(target, me, event.mark.at, event.mark.clock);
      if (next !== target) conversations.set(event.conversationId, next);
      return true;
    }
    if ((target.lastMessageAt ?? 0) <= event.readAt) {
      conversations.set(event.conversationId, { ...target, unreadCount: 0 });
    }
    return true;
  }

  if (event.type === 'read_state') {
    const target = conversations.get(event.conversationId);
    if (!target) return true;
    const next = withRelayedReadState(target, me, event.readWatermarks, event.serverReadWatermarks);
    if (next !== target) {
      conversations.set(event.conversationId, next);
      Log.d(
        `[TAB-SYNC] read state of ${event.conversationId.slice(0, 12)} relayed by the leader: unread ${target.unreadCount ?? 0} -> ${next.unreadCount ?? 0}`
      );
    }
    return true;
  }

  if (event.type === 'unread_counts') {
    for (const [key, count] of Object.entries(event.counts)) {
      const target = conversations.get(key);
      if (!target || (target.unreadCount ?? 0) === count) continue;
      if (isReading(key)) {
        Log.d(`[TAB-SYNC] salon ${key.slice(0, 16)} is being read here - relayed count ignored`);
        continue;
      }
      conversations.set(key, { ...target, unreadCount: count });
    }
    return true;
  }

  return false;
}
