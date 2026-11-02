import type { TabMessageEvent } from '$lib/mls-client/tabMessageSync';
import type { ChatMessage, ReadWatermarks } from '$lib/types';
import { Log } from '$lib/utils/Log';
import { watermarkFor, withOwnReadAdvanced, withReadMark } from './readState';
import { noteSalonOpened } from './salonUnread';
import { noteSalonMarkFromAnotherTab } from './salonReadMarkQueue';

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

/** What a tab knows about itself when an event of the tab channel reaches it. */
export interface TabReadContext<C extends ReadConversation> {
  conversations: Map<string, C>;
  /** This tab's account. */
  me: string;
  /** Whether this tab holds the socket: the leader-only events are the leader's own facts. */
  isLeader: boolean;
  /** Whether this tab is READING the conversation now (`isReadingConversationNow`). */
  isReading: (conversationKey: string) => boolean;
}

/** The events {@link routeTabReadEvent} owns; every other one is the caller's. */
export type TabReadEvent = Extract<
  TabMessageEvent,
  { type: 'conversation_read' | 'read_state' | 'unread_counts' }
>;
const READ_EVENTS = new Set<string>(['conversation_read', 'read_state', 'unread_counts']);

/**
 * THE GATE EVERY CONVERSATION EVENT OF THE TAB CHANNEL PASSES FIRST: one published by a tab of
 * ANOTHER account is dropped here, once, before anything reads it. The channel and the leader lock
 * are per browser; a tab signed into another account hears the same channel, and a
 * `conversation_read` from it would advance THIS account's own watermark (review of #2937).
 *
 * @returns `false` when the event must be ignored.
 */
export function tabEventIsAddressedHere(event: TabMessageEvent, me: string): boolean {
  if (event.account && me && event.account.toLowerCase() === me.toLowerCase()) return true;
  Log.d(
    `[TAB-SYNC] ${event.type} from ${event.account ? `account ${event.account.slice(0, 8)}` : 'an unstamped tab'} dropped - this tab is ${me ? me.slice(0, 8) : 'signed out'}`
  );
  return false;
}

/**
 * ROUTES THE READ HALF OF THE TAB CHANNEL - one entry point, so the role rule and the account rule
 * are each applied in one place. Pure: the store, the account, the role and the "is this tab reading
 * that conversation" fact are handed in, so the two-device tests drive it directly.
 *
 * - `conversation_read` (from ANY tab, applied by either role): a reading carries its mark, which
 *   advances this tab's own watermark and lets the count follow it, and - for a salon - tells this
 *   tab's counts that a mark is on its way from another tab; a selection carries none and zeroes the
 *   badge only when nothing newer than what that tab saw has arrived here since.
 * - `read_state` (from the LEADER; a leader ignores it): one moved mark; this account's own brings
 *   the count down with it, a peer's moves the receipt and nothing else.
 * - `unread_counts` (from the LEADER; a leader ignores it): the salon counts a server answer moved,
 *   except the salon this tab is reading and any whose own mark here is newer than the leader's was.
 *
 * @returns whether the event is one of the three - handled, even if it changed nothing. A type
 *          guard, so the caller's other branches see only the events left to them.
 */
export function routeTabReadEvent<C extends ReadConversation>(
  event: TabMessageEvent,
  ctx: TabReadContext<C>
): event is TabReadEvent {
  if (!READ_EVENTS.has(event.type)) return false;
  const { conversations, me } = ctx;

  if (event.type === 'conversation_read') {
    const target = conversations.get(event.conversationId);
    if (!target) return true;
    if (event.mark) {
      if (event.conversationId.startsWith('channel_')) {
        // The answer to a counts request asked before this read must not re-raise the salon here.
        noteSalonOpened(event.conversationId);
        noteSalonMarkFromAnotherTab();
      }
      const next = withOwnReadAdvanced(target, me, event.mark.at, event.mark.clock);
      if (next !== target) conversations.set(event.conversationId, next);
      return true;
    }
    if ((target.lastMessageAt ?? 0) <= event.readAt) {
      conversations.set(event.conversationId, { ...target, unreadCount: 0 });
    }
    return true;
  }

  // The two below are what the LEADER received; it already holds them.
  if (ctx.isLeader) return true;

  if (event.type === 'read_state') {
    const target = conversations.get(event.conversationId);
    if (!target) return true;
    const own = event.userId.toLowerCase() === me.toLowerCase();
    const next = own
      ? withOwnReadAdvanced(target, me, event.at, event.clock)
      : (withReadMark(target, event.userId, event.at, event.clock) ?? target);
    if (next !== target) {
      conversations.set(event.conversationId, next);
      if (own) {
        Log.d(
          `[TAB-SYNC] own read of ${event.conversationId.slice(0, 12)} relayed by the leader: unread ${target.unreadCount ?? 0} -> ${next.unreadCount ?? 0}`
        );
      }
    }
    return true;
  }

  if (event.type === 'unread_counts') {
    for (const [key, relayed] of Object.entries(event.counts)) {
      const count = relayed?.count;
      const mark = relayed?.mark;
      if (!Number.isInteger(count) || count < 0 || !Number.isFinite(mark) || (mark as number) < 0) {
        console.warn(
          `[TAB-SYNC] relayed count for ${key.slice(0, 16)} is not a count (${JSON.stringify(relayed)}) - ignored`
        );
        continue;
      }
      const target = conversations.get(key);
      if (!target || (target.unreadCount ?? 0) === count) continue;
      if (ctx.isReading(key)) {
        Log.d(`[TAB-SYNC] salon ${key.slice(0, 16)} is being read here - relayed count ignored`);
        continue;
      }
      if (watermarkFor(target.readWatermarks, me) > mark) {
        Log.d(
          `[TAB-SYNC] salon ${key.slice(0, 16)} read here after the leader's count - relayed count ignored`
        );
        continue;
      }
      conversations.set(key, { ...target, unreadCount: count });
    }
    return true;
  }

  return true;
}
