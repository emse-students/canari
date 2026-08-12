import type { ChatMessage } from '$lib/types';
import { compareMessageOrder } from './messageOrder';

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
  existing: Pick<ChatMessage, 'content' | 'isFcmPreview'>,
  incomingContent: string
): boolean {
  if (!isEnvelopeContent(incomingContent)) return false;
  if (existing.isFcmPreview) return true;
  return isFcmPreviewContent(existing.content);
}

/**
 * Merges incoming envelope fields into an existing message (FCM preview upgrade path).
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
    content: incoming.content,
    replyTo: incoming.replyTo ?? existing.replyTo,
    isSystem: incoming.isSystem ?? existing.isSystem,
    isFcmPreview: false,
    serverTimestamp: incoming.serverTimestamp ?? existing.serverTimestamp,
  };
}

/** True when a message has been composed but not yet confirmed by the server. */
function isUnsent(msg: ChatMessage): boolean {
  return msg.status === 'pending' || msg.status === 'sending' || msg.status === 'error';
}

/**
 * Reconciles one message present on BOTH sides. The stored row is authoritative for content and
 * server-assigned fields, with two exceptions that are corrections rather than preferences:
 *
 *   - it may never DOWNGRADE an envelope already on screen back to a notification preview, which is
 *     what taking the page verbatim would do when the page still holds the FCM row;
 *   - `readBy` is grow-only. Reading is optimistically applied in memory before the network ACK, so
 *     taking the page's array wholesale un-reads what the user just read and the badge comes back.
 */
function reconcile(existing: ChatMessage, incoming: ChatMessage): ChatMessage {
  const base = shouldUpgradeMessage(existing, incoming.content)
    ? mergeMessageUpgrade(existing, incoming)
    : isEnvelopeContent(existing.content) && isFcmPreviewContent(incoming.content)
      ? existing
      : { ...incoming };
  const readBy = [...new Set([...(existing.readBy ?? []), ...(incoming.readBy ?? [])])];
  return readBy.length > 0 ? { ...base, readBy } : base;
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
