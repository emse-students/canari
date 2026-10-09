import type { ChatMessage, Conversation } from '$lib/types';
import { publishTabMessageUpdate } from '$lib/mls-client/tabMessageSync';

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
  | { kind: 'state'; status: 'sending' | 'error' | 'pending' }
  /** The server has the message. `serverId` is its row id when this answer carries it. */
  | { kind: 'settled'; serverId?: string | null };

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

  if (change.kind === 'state') {
    if (row.status === change.status) return null;
    const next = [...messages];
    next[idx] = { ...row, status: change.status };
    return next;
  }

  const { serverId } = change;
  if (serverId && serverId !== localId) {
    // The other answer got here first and already put the server's row in the list: the echo is the
    // duplicate, and it is the one that goes.
    if (messages.some((m) => m.id === serverId)) return messages.filter((m, i) => i !== idx);
    const next = [...messages];
    next[idx] = { ...row, id: serverId, status: 'sent', awaitingServerId: undefined };
    return next;
  }
  // No server id in this answer: the message is safe, but the row stays addressable only by the
  // client id until the broadcast frame brings the other half.
  if (row.status === 'sent') return null;
  const next = [...messages];
  next[idx] = { ...row, status: 'sent' };
  return next;
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
      change.kind === 'state' ? change.status : `settled as ${change.serverId?.slice(0, 8) ?? '?'}…`
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
      });
    }
  }
  return true;
}
