import { format, isToday, isYesterday } from 'date-fns';
import { fr } from 'date-fns/locale';
import type { ChatMessage } from '$lib/types';

export type MessageGroup =
  | { type: 'date_separator'; date: string }
  | { type: 'time_separator'; time: string }
  | { type: 'message'; message: ChatMessage };

function formatDateSeparator(date: Date): string {
  if (isToday(date)) return "Aujourd'hui";
  if (isYesterday(date)) return 'Hier';
  return format(date, 'EEEE d MMMM yyyy', { locale: fr });
}

/**
 * Group messages by date and time gaps
 * - Show date separator when day changes
 * - Show time separator when there's a 15+ minute gap
 */
export function groupMessages(messages: ChatMessage[]): MessageGroup[] {
  if (messages.length === 0) return [];

  const groups: MessageGroup[] = [];
  let lastDate: string | null = null;
  let lastTimestamp: number | null = null;
  const TIME_GAP_MS = 15 * 60 * 1000; // 15 minutes

  for (const msg of messages) {
    const msgDate = format(msg.timestamp, 'yyyy-MM-dd');
    const msgTime = msg.timestamp.getTime();

    // Date separator (new day)
    if (lastDate !== msgDate) {
      groups.push({
        type: 'date_separator',
        date: formatDateSeparator(msg.timestamp),
      });
      lastDate = msgDate;
      lastTimestamp = null; // Reset time gap check for new day
    }

    // Time separator (15+ min gap, but not for first message of the day or system messages)
    if (lastTimestamp !== null && !msg.isSystem && msgTime - lastTimestamp > TIME_GAP_MS) {
      groups.push({
        type: 'time_separator',
        time: format(msg.timestamp, 'HH:mm'),
      });
    }

    groups.push({ type: 'message', message: msg });

    lastTimestamp = msgTime;
  }

  return groups;
}
