/**
 * Outbox native mirror - lets the Android background service (app killed) send queued text/reply
 * messages without reopening the app.
 *
 * The TypeScript outbox is the source of truth. This module maintains a plaintext app-private
 * mirror (`outbox_pending.ndjson`) holding, per text/reply entry, the *already-encoded* plaintext
 * proto (base64). The native side reads it, encrypts each proto against the live MLS epoch
 * (`MlsManager::send_message`) and POSTs the ciphertext, with zero crypto-parity work (no KDF to
 * replicate). The proto is epoch-independent, so a mirror written at compose time stays valid until
 * the background send happens.
 *
 * Media entries are excluded: their upload (CEK + encrypt + blob POST) only runs on the foreground
 * MediaService, so a queued media flushes on the next app open, never in the background.
 *
 * Security note: the mirror is plaintext, consistent with the existing app-private posture
 * (`push_context.json` already stores the PIN in clear, `fcm_message_cache.ndjson` stores decrypted
 * previews). The proto contains the message plaintext; it never leaves app-private storage.
 *
 * After a background send, the native side records the sent messageIds in `outbox_sent.ndjson`.
 * `reconcileOutboxSent()` drains that file at login and deletes the corresponding outbox entries.
 * Reconciliation is best-effort: the outbox DB stays authoritative and a missed reconciliation only
 * costs a duplicate proto on the next foreground flush, deduplicated by the receiver on messageId.
 */

import type { IStorage, OutboxEntry } from '$lib/db';
import { buildOutboxProto } from '$lib/utils/chat/outbox';
import { toBase64 } from '$lib/utils/hex';
import { isTauriRuntime } from '$lib/utils/openExternal';
import { appendLog } from '$lib/stores/globalChatSingleton.svelte';

/** One line of `outbox_pending.ndjson`, consumed natively. `proto` is base64(plaintext AppMessage). */
export interface OutboxMirrorEntry {
  id: string;
  groupId: string;
  proto: string;
  sentAt: number;
}

/** Project a queued entry to its mirror form, or null if it cannot be mirrored (media, no proto). */
export function toMirrorEntry(entry: OutboxEntry): OutboxMirrorEntry | null {
  const proto = buildOutboxProto(entry);
  if (!proto) return null;
  return {
    id: entry.id,
    groupId: entry.conversationId,
    proto: toBase64(proto),
    sentAt: entry.sentAt,
  };
}

/**
 * Rewrite the native mirror from the current outbox snapshot (Tauri only; no-op on web/desktop-web).
 * Called after every outbox mutation so the background service always sees the live queue.
 */
export async function syncOutboxMirror(entries: OutboxEntry[]): Promise<void> {
  if (!isTauriRuntime()) return;
  const mirror = entries.map(toMirrorEntry).filter((e): e is OutboxMirrorEntry => e !== null);
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('store_outbox_mirror', { entries: mirror });
  } catch (e) {
    appendLog(
      `[OUTBOX_MIRROR] Ecriture mirror echouee: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

/**
 * Drain `outbox_sent.ndjson` (messageIds the background service already delivered) and delete the
 * matching outbox entries. Tauri only; no-op elsewhere. Idempotent: deleting an absent entry is a
 * no-op, and a duplicate send is deduplicated by the receiver.
 */
export async function reconcileOutboxSent(storage: IStorage): Promise<void> {
  if (!isTauriRuntime()) return;
  let sentIds: string[];
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    sentIds = await invoke<string[]>('read_and_clear_outbox_sent');
  } catch (e) {
    appendLog(
      `[OUTBOX_MIRROR] Lecture outbox_sent echouee: ${e instanceof Error ? e.message : String(e)}`
    );
    return;
  }
  if (!sentIds.length) return;
  appendLog(`[OUTBOX_MIRROR] ${sentIds.length} message(s) envoye(s) en arriere-plan a reconcilier`);
  for (const id of sentIds) {
    await storage.deleteOutboxEntry(id).catch(() => {});
  }
}
