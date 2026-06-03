import type { ChatMessage } from '$lib/types';
import {
  formatLongDateFr,
  formatTime24,
  isToday,
  isYesterday,
  toValidDate,
} from '$lib/utils/dates';
import { compareMessageOrder } from '$lib/utils/chat/messageOrder';

/**
 * A discriminated union representing one visual row in the message list.
 * - `date_separator`: a full-width label showing the day (e.g. "Aujourd'hui", "Hier", "lundi 5 mai 2025").
 * - `time_separator`: a subtle timestamp shown when there is a 15+ minute gap between messages.
 * - `message`: an actual chat message.
 */
export type MessageGroup =
  | { type: 'date_separator'; date: string }
  | { type: 'time_separator'; time: string }
  | { type: 'message'; message: ChatMessage };

/** Message row variant of {@link MessageGroup}. */
export type MessageGroupMessageRow = Extract<MessageGroup, { type: 'message' }>;

/**
 * Type guard for message rows. Accepts null/undefined for safe use during {#each} teardown.
 */
export function isMessageGroupRow(g: MessageGroup | null | undefined): g is MessageGroupMessageRow {
  return g != null && g.type === 'message';
}

function formatDateSeparator(date: Date): string {
  if (isToday(date)) return "Aujourd'hui";
  if (isYesterday(date)) return 'Hier';
  return formatLongDateFr(date);
}

/** Returns true if `msgs` is already in ascending message order. O(n) - avoids the O(n log n) sort in the common case where messages arrive in order. */
function isAlreadySorted(msgs: ChatMessage[]): boolean {
  for (let i = 1; i < msgs.length; i++) {
    if (compareMessageOrder(msgs[i - 1], msgs[i]) > 0) return false;
  }
  return true;
}

/**
 * Group messages by date and time gaps.
 * - Show date separator when day changes
 * - Show time separator when there's a 15+ minute gap
 *
 * Sorts the input chronologically before grouping so callers don't need to
 * pre-sort - this is the last line of defence against upstream ordering bugs.
 * The sort is skipped when the array is already ordered (the common case),
 * cutting O(n log n) work on every new message in long conversations.
 */
export function groupMessages(messages: ChatMessage[]): MessageGroup[] {
  if (messages.length === 0) return [];

  const sorted = isAlreadySorted(messages) ? messages : [...messages].sort(compareMessageOrder);
  const groups: MessageGroup[] = [];
  let lastDate: string | null = null;
  let lastTimestamp: number | null = null;
  const TIME_GAP_MS = 15 * 60 * 1000; // 15 minutes

  for (const msg of sorted) {
    const d = toValidDate(msg.timestamp);
    const msgDate = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const msgTime = d.getTime();

    // Date separator (new day)
    if (lastDate !== msgDate) {
      groups.push({
        type: 'date_separator',
        date: formatDateSeparator(d),
      });
      lastDate = msgDate;
      lastTimestamp = null; // Reset time gap check for new day
    }

    // Time separator (15+ min gap, but not for first message of the day or system messages)
    if (lastTimestamp !== null && !msg.isSystem && msgTime - lastTimestamp > TIME_GAP_MS) {
      groups.push({
        type: 'time_separator',
        time: formatTime24(d),
      });
    }

    groups.push({ type: 'message', message: msg });

    lastTimestamp = msgTime;
  }

  return groups;
}
