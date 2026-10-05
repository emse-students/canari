import type { ChatMessage } from '$lib/types';
import { applyEditToBody, envelopeBodyText, parseEnvelope } from '$lib/envelope';
import { editSupersedes } from '$lib/utils/chat/editPrecedence';

/** An edit frame read off a salon row: whose it is, what it replaces, and when it was made. */
export interface DecodedChannelEdit {
  /** The SERVER row id of the edited message, the key every salon operation addresses it by. */
  targetMessageId: string;
  /** The row's sender: proven by the Graine v2 signature, never read from the frame's body. */
  senderId: string;
  /** The replacement TEXT, never a body - the reply reference stays in the row. */
  newContent: string;
  /** The author's clock, Unix ms. The larger one wins, see `editSupersedes`. */
  editedAt: number;
}

/**
 * Applies one salon edit to a message list, or returns the same list untouched and says why.
 *
 * AUTHORSHIP IS DECIDED HERE, BY EVERY READER, AND NOT BY THE SERVER. A salon row is an opaque blob
 * to the server (Graine), so it cannot know that a frame is an edit, let alone whose message it
 * edits. What it does know, and what Graine v2 makes unforgeable, is who SEALED the row. So an edit
 * is honoured only when its sender is the target's author - the rule `mutationIsAuthorised` applies
 * to a group's `edit_message` - and a moderator's `channel.moderate` widens deletion only, never
 * this: a moderator may remove someone's words but not put others in their mouth.
 *
 * It is the same function on the live path, on a history page and on the sender's own optimistic
 * write, so the three cannot disagree. Every refusal is logged: a dropped edit is silent to the
 * user by design, and the line is all it leaves behind.
 *
 * Only a plain TEXT message is editable. A poll, a notice, a media message and a tombstone are not,
 * and `applyEditToBody` would turn the first two into text, which is why it is checked first.
 */
export function applyChannelEdit(
  messages: ChatMessage[],
  edit: DecodedChannelEdit,
  log: (line: string) => void = console.warn
): { messages: ChatMessage[]; applied: boolean } {
  const short = edit.targetMessageId.slice(0, 8);
  if (!edit.targetMessageId || !edit.newContent.trim()) {
    log(
      `[CHANNEL] Dropped an edit of ${short || 'no message'} - it names nothing or carries no text`
    );
    return { messages, applied: false };
  }
  const idx = messages.findIndex((m) => m.id === edit.targetMessageId);
  if (idx === -1) {
    log(`[CHANNEL] Edit of ${short} not applied - the message is not loaded on this device`);
    return { messages, applied: false };
  }
  const target = messages[idx];
  if ((target.senderId ?? '').toLowerCase() !== edit.senderId.toLowerCase()) {
    log(
      `[CHANNEL] REFUSED an edit of ${short} by ${edit.senderId.slice(0, 8)} - the message is ${(target.senderId ?? '').slice(0, 8)}'s and only its author may edit it`
    );
    return { messages, applied: false };
  }
  if (target.isDeleted || target.isSystem || parseEnvelope(target.content).kind !== 'text') {
    log(`[CHANNEL] Dropped an edit of ${short} - the message is deleted or is not plain text`);
    return { messages, applied: false };
  }
  // The author's own device applies its edit locally and then receives the same row back: that
  // echo is the expected second delivery of a state already held, not a loss worth a line.
  if (
    target.isEdited &&
    target.editedAt?.getTime() === edit.editedAt &&
    envelopeBodyText(target.content) === edit.newContent
  ) {
    return { messages, applied: false };
  }
  if (!editSupersedes({ editedAt: edit.editedAt, content: edit.newContent }, target)) {
    log(`[CHANNEL] Dropped an edit of ${short} dated ${edit.editedAt} - the row holds a later one`);
    return { messages, applied: false };
  }
  const next = [...messages];
  next[idx] = {
    ...target,
    isEdited: true,
    editedAt: new Date(edit.editedAt),
    content: applyEditToBody(target.content, edit.newContent),
  };
  return { messages: next, applied: true };
}

/**
 * Applies a page's edit frames to its messages in ONE order-independent pass.
 *
 * Frames are applied oldest first only for tidiness: `editSupersedes` already makes the outcome the
 * same in any order, so a page read newest-first and one read oldest-first end on one text.
 */
export function applyChannelEdits(
  messages: ChatMessage[],
  edits: DecodedChannelEdit[],
  log?: (line: string) => void
): ChatMessage[] {
  let current = messages;
  for (const edit of [...edits].sort((a, b) => a.editedAt - b.editedAt)) {
    current = applyChannelEdit(current, edit, log).messages;
  }
  return current;
}
