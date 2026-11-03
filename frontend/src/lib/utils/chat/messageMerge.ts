import type { ChatMessage } from '$lib/types';
import type { StoredMessage } from '$lib/db/types';
import { mergeStoredMessage } from '$lib/db/messagePayload';
import { compareMessageOrder } from './messageOrder';
import { mergeReactions } from './messageReactions';
import { applyEditToBody, envelopeBodyText } from '$lib/envelope';

/** Returns true when `content` is a serialized MessageEnvelope JSON object. */
export function isEnvelopeContent(content: string): boolean {
  // Cheap pre-filter: every envelope is a JSON object carrying a `kind` field.
  // Skips JSON.parse for plain previews and non-envelope `{` strings.
  if (!content.startsWith('{') || !content.includes('"kind"')) return false;
  try {
    const obj = JSON.parse(content) as { kind?: unknown };
    return typeof obj.kind === 'string';
  } catch {
    return false;
  }
}

/** True for FCM notification previews (plain text, not a full envelope). */
export function isFcmPreviewContent(content: string): boolean {
  return !isEnvelopeContent(content);
}

/**
 * Whether an existing chat row should be replaced with richer MLS envelope content.
 * Upgrades FCM/plain previews when the incoming payload is a full envelope.
 */
export function shouldUpgradeMessage(
  existing: Pick<ChatMessage, 'content' | 'isFcmPreview' | 'isDeleted'>,
  incomingContent: string
): boolean {
  if (!isEnvelopeContent(incomingContent)) return false;
  // A DELETE IS ABSORBING, AND A PREVIEW CAN BE DELETED. A notification's caption is in memory
  // before the drain reaches the body, and a `delete_message` in the same drain tombstones that
  // caption - which still carries `isFcmPreview`. Upgrading it then wrote the deleted body back.
  if (existing.isDeleted) return false;
  if (existing.isFcmPreview) return true;
  return isFcmPreviewContent(existing.content);
}

/**
 * Whether `row` is a push PREVIEW standing in for a body not here yet: flagged (`isFcmPreview`,
 * sealed with the row since #2936), or - for a row an older build stored without the flag - a body
 * that is not an envelope. A deleted row is not one: the tombstone is final.
 */
export function isPushPreview(row: {
  isDeleted?: boolean;
  isFcmPreview?: boolean;
  content: string;
}): boolean {
  if (row.isDeleted) return false;
  return row.isFcmPreview === true || isFcmPreviewContent(row.content);
}

/**
 * The body an upgrade writes, with the edit the PREVIEW already took carried onto it. A signed edit
 * can reach a preview (a history bundle applies one), and the upgrade takes the body's content - so
 * without this the edit was laid under the body, and lost while `isEdited` stayed. The preview's
 * edited text is applied to the new body (`applyEditToBody`, which keeps the reply quote) unless
 * the upgrade carries an edit of its own at least as recent.
 */
function bodyWithPreviewEdit(
  preview: { isEdited?: boolean; editedAt?: number | Date | null; content: string },
  upgrade: { isEdited?: boolean; editedAt?: number | Date | null; content: string }
): string {
  if (!preview.isEdited) return upgrade.content;
  const at = (v: number | Date | null | undefined) => (v instanceof Date ? v.getTime() : (v ?? 0));
  if (upgrade.isEdited && at(upgrade.editedAt) >= at(preview.editedAt)) return upgrade.content;
  return applyEditToBody(upgrade.content, envelopeBodyText(preview.content));
}

/**
 * Merges incoming envelope fields into an existing message (FCM preview upgrade path), carrying an
 * edit the preview took onto the body ({@link bodyWithPreviewEdit}).
 */
export function mergeMessageUpgrade(
  existing: ChatMessage,
  incoming: Pick<
    ChatMessage,
    'content' | 'replyTo' | 'isSystem' | 'serverTimestamp' | 'isFcmPreview'
  >
): ChatMessage {
  return {
    ...existing,
    content: bodyWithPreviewEdit(existing, incoming),
    replyTo: incoming.replyTo ?? existing.replyTo,
    isSystem: incoming.isSystem ?? existing.isSystem,
    isFcmPreview: false,
    serverTimestamp: incoming.serverTimestamp ?? existing.serverTimestamp,
  };
}

/**
 * A preview's upgrade folded onto the stored row AS IT STANDS AT THE WRITE - the merge a
 * compare-and-set runs (`IStorage.mergeMessages`), never a whole row written over it.
 *
 * `null` when the stored row is no longer a preview this body upgrades (deleted, or upgraded by
 * another writer since the caller looked): it is left as it is. Otherwise the upgrade's fields are
 * laid over it, with three things the upgrade can only ADD to, never take away - which a whole-row
 * write did, erasing a reaction merged onto the preview between the caller's read and its write:
 *
 *   - the reactions are the union of both, pair by pair (`mergeReactions`);
 *   - a deletion, an edit and a recorded media purge the upgrade does not carry stay as stored
 *     (`false` and absent alike say nothing, and a tombstone already refused the upgrade above).
 */
export function previewUpgradeOnto(
  current: StoredMessage,
  upgrade: StoredMessage
): StoredMessage | null {
  if (!shouldUpgradeMessage(current, upgrade.content)) return null;
  const { reactions, isDeleted, isEdited, editedAt, mediaPurgedAt, ...rest } = upgrade;
  return mergeStoredMessage(current, {
    ...rest,
    content: bodyWithPreviewEdit(current, upgrade),
    isFcmPreview: false,
    reactions: mergeReactions(current.reactions ?? [], reactions ?? []) ?? current.reactions,
    ...(isDeleted ? { isDeleted } : {}),
    ...(isEdited ? { isEdited, ...(editedAt ? { editedAt } : {}) } : {}),
    ...(mediaPurgedAt ? { mediaPurgedAt } : {}),
  });
}

/** True when a message has been composed but not yet confirmed by the server. */
function isUnsent(msg: ChatMessage): boolean {
  return (
    msg.status === 'pending' ||
    msg.status === 'sending' ||
    msg.status === 'error' ||
    msg.status === 'unconfirmed'
  );
}

/**
 * Reconciles one message present on BOTH sides. The stored row is authoritative for content and
 * server-assigned fields, with one exception that is a correction rather than a preference: it may
 * never DOWNGRADE an envelope already on screen back to a notification preview, which is what
 * taking the page verbatim would do when the page still holds the FCM row.
 *
 * Read state used to need a rule here too - the page's `readBy` would un-read what the user had
 * just read. It no longer lives on the message at all, so a page read cannot carry a stale copy of
 * it: see `$lib/utils/chat/readState`.
 */
function reconcile(existing: ChatMessage, incoming: ChatMessage): ChatMessage {
  const kept = shouldUpgradeMessage(existing, incoming.content)
    ? mergeMessageUpgrade(existing, incoming)
    : isEnvelopeContent(existing.content) && isFcmPreviewContent(incoming.content)
      ? existing
      : { ...incoming };
  // Whichever version is kept, the page's position of the row is the store's latest word on it:
  // "load older" pages below the lowest one held (`oldestPageKey`).
  return incoming.pageKey && kept.pageKey !== incoming.pageKey
    ? { ...kept, pageKey: incoming.pageKey }
    : kept;
}

/**
 * Unions a freshly read page of messages into the list already on screen.
 *
 * A PAGE READ IS EVIDENCE ABOUT A WINDOW OF THE PAST, NEVER A STATEMENT THAT NOTHING ELSE EXISTS.
 * Every history load in the app follows the same shape - fetch, decrypt, persist, then re-read a page
 * from the store to render - and each one used to ASSIGN that page over `messages`. The read is
 * issued at the end of a load that takes seconds, so anything delivered while it ran was on screen
 * and then silently vanished when the load resolved. Measured 2026-08-12 on the live DM: the message
 * rendered at +0.5 s and disappeared at +3.4 s, exactly as the pane grew from 2 808 to 15 756
 * characters, and it came back only after a reload - the store had it all along, the rendered list
 * did not.
 *
 * The rule that replaces the assignment holds at any conversation size and needs no timer:
 *
 *   - the page is authoritative INSIDE the window it covers, so a message the page omits from
 *     between its oldest and newest row is genuinely gone and is dropped;
 *   - memory is authoritative OUTSIDE that window - newer arrivals the read could not have seen, and
 *     older pages already scrolled in, are both kept;
 *   - an UNSENT message is kept wherever it sits, because no page can ever carry it.
 *
 * An empty page asserts nothing at all and therefore removes nothing.
 */
export function mergeMessagePage(current: ChatMessage[], page: ChatMessage[]): ChatMessage[] {
  if (current.length === 0) return [...page].sort(compareMessageOrder);
  if (page.length === 0) return [...current].sort(compareMessageOrder);

  const sortedPage = [...page].sort(compareMessageOrder);
  const oldest = sortedPage[0];
  const newest = sortedPage[sortedPage.length - 1];
  const inPage = new Map(sortedPage.map((m) => [m.id, m]));

  const merged: ChatMessage[] = [];
  for (const existing of current) {
    const incoming = inPage.get(existing.id);
    if (incoming) {
      merged.push(reconcile(existing, incoming));
      inPage.delete(existing.id);
      continue;
    }
    const outsideWindow =
      compareMessageOrder(existing, oldest) < 0 || compareMessageOrder(existing, newest) > 0;
    if (outsideWindow || isUnsent(existing)) merged.push(existing);
  }
  merged.push(...inPage.values());
  return merged.sort(compareMessageOrder);
}
