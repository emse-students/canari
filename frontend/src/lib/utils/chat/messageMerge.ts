import type { ChatMessage } from '$lib/types';

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
