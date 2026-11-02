/**
 * Edits that reached this device before the message they rewrite (2026-11-02).
 *
 * A device that was away receives a message and its edit in ONE catch-up drain, and the drain
 * buffers the message body until it ends (`beginBulkMessageIngest`) while it handles the edit at
 * once: at that instant the body is in neither memory nor the store. The edit used to be dropped,
 * its frame consumed for good. It is HELD here instead, keyed by the message id, and the seam that
 * materialises the body takes it (`useMessaging.svelte.ts`, `addMessageToChat` / `batchAddMessages`)
 * - applied only when the body's author is the editor, exactly as the live handler checks a held row.
 *
 * In memory, for the session. A deletion that arrives first is kept durably as a row
 * (`StoredMessage.deletedBeforeArrival`); an edit has no row to stand in, and a durable home for it
 * is a new local table - a migration this change does not make. Recorded in
 * `docs/wiki/protocols/history-reconciliation.md#deletion-purges`.
 */
import type { RecordedAuthorship } from '$lib/crypto/messageAuthorship';
import { canonicalUserId } from '$lib/mls-client/leafIdentity';
import { editSupersedes } from './editPrecedence';

/** An edit held for a message this device does not hold yet. */
export interface HeldEdit {
  /** The editor, as MLS authenticated the frame - checked against the body's author on arrival. */
  by: string;
  /** The replacement TEXT, applied to the body with `applyEditToBody`. */
  text: string;
  /** The editor's own clock, the order `editSupersedes` reads. */
  editedAt: number;
  /** The editor's signed `edit_message`, kept on the row it is applied to. */
  proof?: RecordedAuthorship;
}

const held = new Map<string, HeldEdit>();

/**
 * Holds `edit` for `messageId` until its body arrives. Of two held edits the later one wins, by the
 * rule every applier of an edit uses (`editSupersedes`), so the order they arrive in does not matter.
 */
export function holdEdit(messageId: string, edit: HeldEdit): void {
  const earlier = held.get(messageId);
  if (
    earlier &&
    !editSupersedes(
      { editedAt: edit.editedAt, content: edit.text },
      { editedAt: earlier.editedAt, content: earlier.text }
    )
  ) {
    return;
  }
  held.set(messageId, edit);
}

/**
 * Takes the edit held for `messageId` when its body, by `authorId`, arrives - and forgets it either
 * way. An edit by anybody else is not the author's and is returned as refused, never applied.
 */
export function takeHeldEdit(
  messageId: string,
  authorId: string
): { edit: HeldEdit } | { refused: HeldEdit } | null {
  const edit = held.get(messageId);
  if (!edit) return null;
  held.delete(messageId);
  return canonicalUserId(edit.by) === canonicalUserId(authorId) ? { edit } : { refused: edit };
}

/** Forgets every held edit: they belong to the account whose session is ending. */
export function clearHeldEdits(): void {
  held.clear();
}
