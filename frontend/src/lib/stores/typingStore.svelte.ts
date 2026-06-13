import { SvelteMap } from 'svelte/reactivity';

/**
 * Reactive store of "who is currently typing" per conversation.
 *
 * Keyed by `conversation.id` (the MLS groupId for DMs/groups, or `channel_<id>`
 * for community channels) so the chat view can look it up directly. Each typing
 * entry auto-expires after {@link TYPING_TTL_MS} unless refreshed by a new signal,
 * which keeps the indicator from sticking if a `stop` frame is ever lost.
 */

/** Auto-expiry window for a typing indicator when no refresh/stop arrives. */
const TYPING_TTL_MS = 6000;

/** conversationId → (userId → expiry timer handle). */
const typing = new SvelteMap<string, SvelteMap<string, ReturnType<typeof setTimeout>>>();

/** Returns the userIds currently typing in a conversation (reactive). */
export function typingUsersFor(conversationId: string): string[] {
  const inner = typing.get(conversationId);
  return inner ? [...inner.keys()] : [];
}

function clearEntry(conversationId: string, userId: string) {
  const inner = typing.get(conversationId);
  const handle = inner?.get(userId);
  if (handle) clearTimeout(handle);
  inner?.delete(userId);
  if (inner && inner.size === 0) typing.delete(conversationId);
}

/**
 * Records (or clears) a user's typing state for a conversation.
 * `isTyping = true` (re)arms the auto-expiry; `false` removes the entry immediately.
 */
export function setTyping(conversationId: string, userId: string, isTyping: boolean): void {
  const id = conversationId.trim();
  const uid = userId.trim().toLowerCase();
  if (!id || !uid) return;

  if (!isTyping) {
    clearEntry(id, uid);
    return;
  }

  let inner = typing.get(id);
  if (!inner) {
    inner = new SvelteMap();
    typing.set(id, inner);
  }
  const existing = inner.get(uid);
  if (existing) clearTimeout(existing);
  inner.set(
    uid,
    setTimeout(() => clearEntry(id, uid), TYPING_TTL_MS)
  );
}
