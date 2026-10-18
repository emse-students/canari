import type { ChatMessage, Conversation } from '$lib/types';
import { publishTabMessageUpdate } from '$lib/mls-client/tabMessageSync';
import { insertMessageOrdered } from '$lib/utils/chat/messageOrder';

/**
 * THE LOCAL ROW OF A COMMUNITY-SALON MESSAGE, from the click to the server's row (WP-OFF-2).
 *
 * A DM or group message has ONE id for its whole life, so its optimistic row is simply patched
 * (`outbox.ts` `patchStatus`). A salon message has two: the client UUID the row is shown under, and
 * the id the SERVER mints for its own row (`channel.dto.ts`) - the one every later action (react,
 * edit, delete, pin) addresses, and the one the `channel.message.created` frame and the history
 * load key their bubble by. The echo therefore carries `awaitingServerId` until it is RE-KEYED, in
 * place (the bubble does not remount), by whichever of the two answers arrives first: the POST's
 * own reply, or the broadcast frame carrying the same client UUID inside its ciphertext.
 *
 * Pure on purpose: {@link nextEchoMessages} is the whole rule and takes and returns an array.
 */
export type SalonEchoChange =
  /** The send is in flight, or the server refused it: the row says so, nothing else moves. */
  | { kind: 'state'; status: 'sending' | 'error' | 'pending' | 'unconfirmed' }
  /**
   * The server has the message. `serverId` is its row id and `serverMs` its `createdAt` when this
   * answer carries them.
   */
  | { kind: 'settled'; serverId?: string | null; serverMs?: number }
  /** The message was deleted after it landed (a refused repeat): its row goes. */
  | { kind: 'gone' };

/**
 * The messages after `change`, or `null` when nothing changed (no flagged row under `localId`, or
 * it is already in that state) - so a caller can skip the write, and a second answer is a no-op.
 */
export function nextEchoMessages(
  messages: ChatMessage[],
  localId: string,
  change: SalonEchoChange
): ChatMessage[] | null {
  const idx = messages.findIndex((m) => m.id === localId && m.awaitingServerId === true);
  if (idx === -1) return null;
  const row = messages[idx];

  if (change.kind === 'gone') return messages.filter((_, i) => i !== idx);
  if (change.kind === 'state') {
    if (row.status === change.status) return null;
    const next = [...messages];
    next[idx] = { ...row, status: change.status };
    return next;
  }

  const { serverId } = change;
  // ONE CLOCK FOR EVERY SALON ROW. The echo was drawn at the author's `sentAt`; the server's row is
  // dated by its `createdAt` on both the live and the history path, and read marks compare against
  // that column. A settled echo keeping the author's clock would sort, and anchor "seen by", by a
  // time no other device uses for it - ahead of the server's by up to seconds on production.
  const dated =
    change.serverMs !== undefined && Number.isFinite(change.serverMs)
      ? { timestamp: new Date(change.serverMs), serverTimestamp: change.serverMs }
      : {};
  if (serverId && serverId !== localId) {
    // The other answer got here first and already put the server's row in the list: the echo is the
    // duplicate, and it is the one that goes.
    if (messages.some((m) => m.id === serverId)) return messages.filter((m, i) => i !== idx);
    return placeAt(messages, idx, {
      ...row,
      ...dated,
      id: serverId,
      status: 'sent',
      awaitingServerId: undefined,
    });
  }
  // No server id in this answer: the message is safe, but the row stays addressable only by the
  // client id until the broadcast frame brings the other half.
  if (row.status === 'sent') return null;
  return placeAt(messages, idx, { ...row, ...dated, status: 'sent' });
}

/**
 * `messages` with the row at `idx` replaced by `updated`, moved only as far as its (server) time
 * requires.
 *
 * The echo was appended at the author's click; the server may have stamped a message from somebody
 * else, already drawn below the echo, EARLIER than ours. Leaving the row where it was would show the
 * two in an order no other device shows and the next history load would reverse. Most of the time
 * the row is already in place and this is a replacement; nothing ever moves past a row with the same
 * time, so equal stamps keep the order they were drawn in.
 */
function placeAt(messages: ChatMessage[], idx: number, updated: ChatMessage): ChatMessage[] {
  const rest = messages.filter((_, i) => i !== idx);
  const at = updated.timestamp.getTime();
  let insertAt = idx;
  while (insertAt > 0 && rest[insertAt - 1].timestamp.getTime() > at) insertAt -= 1;
  while (insertAt < rest.length && rest[insertAt].timestamp.getTime() < at) insertAt += 1;
  rest.splice(insertAt, 0, updated);
  return rest;
}

/**
 * Applies {@link nextEchoMessages} to the live conversation `key`, and - once the row is re-keyed -
 * tells the sibling tabs about it, because an echo is never announced while it has no server id.
 *
 * @returns whether the conversation changed.
 */
export function applySalonEchoChange(
  conversations: {
    get(key: string): Conversation | undefined;
    set(key: string, value: Conversation): unknown;
  },
  key: string,
  localId: string,
  change: SalonEchoChange,
  log: (msg: string) => void
): boolean {
  const convo = conversations.get(key);
  if (!convo) return false;
  const messages = nextEchoMessages(convo.messages, localId, change);
  if (!messages) return false;
  conversations.set(key, { ...convo, messages });
  log(
    `[SALON-ECHO] ${localId.slice(0, 8)}… ${
      change.kind === 'state'
        ? change.status
        : change.kind === 'gone'
          ? 'removed: deleted after it landed'
          : `settled as ${change.serverId?.slice(0, 8) ?? '?'}…`
    }`
  );
  if (change.kind === 'settled' && change.serverId) {
    const settled = messages.find((m) => m.id === change.serverId);
    if (settled) {
      publishTabMessageUpdate({
        type: 'message_added',
        conversationId: key,
        message: settled,
        lastMessageAt: convo.lastMessageAt ?? settled.timestamp.getTime(),
        unreadCount: convo.unreadCount ?? 0,
        clientMessageId: localId,
      });
    }
  }
  return true;
}

/**
 * A row another tab announced (`message_added`), merged into this tab's list.
 *
 * When it names the client id of an echo THIS tab is still showing - this tab composed it, the leader
 * received the frame - the echo is settled under the announced server id, never drawn beside it: the
 * duplicate the follower tab used to show until a reload. Otherwise a row already present is a no-op.
 *
 * @returns the next list and whether an echo was settled (the caller then forgets its send), or
 *   `null` when nothing changed.
 */
export function mergeAnnouncedMessage(
  messages: ChatMessage[],
  message: ChatMessage,
  clientMessageId?: string
): { messages: ChatMessage[]; settledEcho: boolean } | null {
  if (clientMessageId) {
    const settled = nextEchoMessages(messages, clientMessageId, {
      kind: 'settled',
      serverId: message.id,
      serverMs: message.serverTimestamp,
    });
    if (settled) return { messages: settled, settledEcho: true };
  }
  if (messages.some((m) => m.id === message.id)) return null;
  return { messages: insertMessageOrdered(messages, message), settledEcho: false };
}
