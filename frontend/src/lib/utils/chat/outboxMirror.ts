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
 * MediaService, so a queued media flushes on the next app open, never in the background. Control
 * events (reaction/edit/delete/read) ARE mirrored - the motivating case is `delete`, whose
 * retraction would otherwise stay visible on peers until the app reopens even though its target
 * body was already sent in the background. (Safe since C1/C2 serialise cross-engine mls.bin writes.)
 *
 * Security note: the mirror is plaintext, consistent with the existing app-private posture
 * (`push_context.json` already stores the PIN in clear, `fcm_message_cache.ndjson` stores decrypted
 * previews). The proto contains the message plaintext; it never leaves app-private storage.
 *
 * After a background send, the native side records the sent messageIds in `outbox_sent.ndjson`.
 * `reconcileOutboxSent()` drains that file at login and deletes the corresponding outbox entries.
 * Reconciliation is best-effort: the outbox DB stays authoritative and a missed reconciliation only
 * costs a duplicate proto on the next foreground flush, deduplicated by the receiver on messageId.
 *
 * The mirror is not write-only, though: the notification quick reply builds its proto natively and
 * appends it here, so an entry the background drain could NOT deliver exists only in this file -
 * and `syncOutboxMirror` rewrites the file from the TS queue, which would wipe it. That is what
 * `adoptOrphanedMirrorEntries()` prevents: at login, any mirror entry the TS outbox does not know
 * about is turned back into a real outbox entry (plus the local message the sender never got), so
 * the ordinary flusher owns it from then on. It is the symmetric twin of `reconcileOutboxSent`.
 */

import type { IStorage, OutboxEntry, StoredMessage } from '$lib/db';
import { buildOutboxProto, deliveryForOutboxEntry } from '$lib/utils/chat/outbox';
import { decodeAppMessage } from '$lib/proto/codec';
import { fromBase64, toBase64 } from '$lib/utils/hex';
import { isTauriRuntime } from '$lib/utils/openExternal';
import { appendLog } from '$lib/stores/globalChatSingleton.svelte';

/** One line of `outbox_pending.ndjson`, consumed natively. `proto` is base64(plaintext AppMessage). */
export interface OutboxMirrorEntry {
  id: string;
  groupId: string;
  proto: string;
  sentAt: number;
  /**
   * Silent send (no recipient notification) - true for control events (reaction/edit/delete/read),
   * mirroring the foreground flusher. The server cannot infer this from the E2E ciphertext, so it
   * must travel with the entry; without it a background-sent delete/reaction would trigger a
   * spurious push on peers.
   */
  silent: boolean;
  /**
   * Append to the group's shared log. Travels for the same reason as {@link silent} and is
   * deliberately independent of it: a mutation sent from the background must be exactly as durable
   * as one sent from the foreground, or which path delivered it would decide whether an absent
   * device can ever learn about it.
   */
  durable: boolean;
}

/** Project a queued entry to its mirror form, or null if it cannot be mirrored (media, no proto). */
export function toMirrorEntry(entry: OutboxEntry): OutboxMirrorEntry | null {
  // buildOutboxProto returns null for media (foreground upload only) and the verbatim proto for
  // text/reply and control (reaction/edit/delete/read). Control is mirrored now that C1/C2 make
  // background mls.bin writes safe - notably `delete`, so a retraction is not stuck behind an
  // already-sent body until the app reopens.
  const proto = buildOutboxProto(entry);
  if (!proto) return null;
  const { silent, durable } = deliveryForOutboxEntry(entry);
  return {
    id: entry.id,
    groupId: entry.conversationId,
    proto: toBase64(proto),
    sentAt: entry.sentAt,
    silent,
    durable,
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
      `[OUTBOX_MIRROR] Mirror write failed (${mirror.length} entries): ${e instanceof Error ? e.message : String(e)}`
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
      `[OUTBOX_MIRROR] outbox_sent read failed: ${e instanceof Error ? e.message : String(e)}`
    );
    return;
  }
  if (!sentIds.length) return;
  appendLog(`[OUTBOX_MIRROR] ${sentIds.length} message(s) sent in the background to reconcile`);
  for (const id of sentIds) {
    await storage.deleteOutboxEntry(id).catch(() => {});
  }
}

/** A mirror entry turned back into queue state: what to flush, and what to show meanwhile. */
interface AdoptedMirrorEntry {
  outbox: OutboxEntry;
  /** Local copy of the pending message, or null when the entry carries no displayable body. */
  message: StoredMessage | null;
}

/**
 * Rebuild a real outbox entry (and the local message it should have left) from a mirror line.
 * Returns null when the proto cannot be understood, which is the one case worth a log: the entry
 * would otherwise be dropped silently by the next mirror rewrite, exactly the bug being fixed.
 */
function adoptMirrorEntry(entry: OutboxMirrorEntry, userId: string): AdoptedMirrorEntry | null {
  let proto: Uint8Array;
  try {
    proto = fromBase64(entry.proto);
  } catch (e) {
    appendLog(
      `[OUTBOX_MIRROR] Orphan ${entry.id.slice(0, 8)}… has an unreadable proto: ${String(e)}`
    );
    return null;
  }
  const now = Date.now();
  const base = {
    id: entry.id,
    conversationId: entry.groupId,
    sentAt: entry.sentAt,
    status: 'pending' as const,
    attempts: 0,
    createdAt: entry.sentAt || now,
  };

  // A silent entry is a control event (reaction/edit/delete/read): the flusher sends its proto
  // verbatim and silently, which is exactly what `kind: 'control'` means. Nothing to display.
  if (entry.silent) {
    return { outbox: { ...base, kind: 'control', controlProto: proto }, message: null };
  }

  // Anything else is a user-visible body, today only the native quick reply. Decode it so the
  // entry becomes a first-class text/reply the flusher re-encodes identically (same messageId,
  // same sentAt), instead of an opaque blob only this code path could send.
  const app = decodeAppMessage(proto);
  if (app?.reply?.content !== undefined && app.reply?.replyTo) {
    const replyTo = {
      id: app.reply.replyTo.id ?? '',
      senderId: app.reply.replyTo.senderId ?? '',
      preview: app.reply.replyTo.preview ?? '',
    };
    const text = app.reply.content ?? '';
    return {
      outbox: { ...base, kind: 'reply', text, replyTo },
      message: {
        id: entry.id,
        conversationId: entry.groupId,
        senderId: userId.toLowerCase(),
        content: text,
        timestamp: entry.sentAt,
      },
    };
  }
  if (app?.text?.content !== undefined) {
    const text = app.text.content ?? '';
    return {
      outbox: { ...base, kind: 'text', text },
      message: {
        id: entry.id,
        conversationId: entry.groupId,
        senderId: userId.toLowerCase(),
        content: text,
        timestamp: entry.sentAt,
      },
    };
  }
  appendLog(
    `[OUTBOX_MIRROR] Orphan ${entry.id.slice(0, 8)}… is neither text nor reply - cannot adopt it`
  );
  return null;
}

/**
 * Adopt into the TypeScript outbox every mirror entry it does not already know about, and persist
 * the local copy of each so the sender finally sees what they sent. Tauri only; no-op elsewhere.
 *
 * Must run BEFORE conversations are loaded: the adopted message is written to the store and picked
 * up by the ordinary history load, which is also what gives it its `pending` status afterwards.
 *
 * A delivered background send is removed from the mirror by the native drain, so an entry still
 * present here was NOT delivered. Should one race through anyway, `reconcileOutboxSent` deletes it
 * moments later - adoption is idempotent on the stable messageId either way.
 */
export async function adoptOrphanedMirrorEntries(
  storage: IStorage,
  deviceKeyB64: string,
  userId: string
): Promise<number> {
  if (!isTauriRuntime()) return 0;
  let mirror: OutboxMirrorEntry[];
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    mirror = await invoke<OutboxMirrorEntry[]>('read_outbox_mirror');
  } catch (e) {
    appendLog(`[OUTBOX_MIRROR] Mirror read failed: ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }
  if (!mirror.length) return 0;

  const known = await storage
    .getOutboxEntries(deviceKeyB64)
    .catch((e) => {
      // Treating a failed read as an empty queue here would re-adopt the whole live queue, so this
      // is the one branch that must give up rather than guess.
      appendLog(`[OUTBOX_MIRROR] Outbox read failed, adoption skipped: ${String(e)}`);
      return null;
    })
    .then((entries) => (entries ? new Set(entries.map((e) => e.id)) : null));
  if (!known) return 0;

  const orphans = mirror.filter((e) => e.id && !known.has(e.id));
  if (!orphans.length) return 0;
  appendLog(`[OUTBOX_MIRROR] ${orphans.length} orphan mirror entr(y/ies) to adopt`);

  let adopted = 0;
  for (const orphan of orphans) {
    const rebuilt = adoptMirrorEntry(orphan, userId);
    if (!rebuilt) continue;
    try {
      await storage.saveOutboxEntry(rebuilt.outbox, deviceKeyB64);
    } catch (e) {
      appendLog(`[OUTBOX_MIRROR] Adoption of ${orphan.id.slice(0, 8)}… failed: ${String(e)}`);
      continue;
    }
    adopted++;
    if (rebuilt.message) {
      // Best-effort: the entry is queued either way, this only decides whether the user can see it
      // before it lands. A missing conversation row is the expected failure (FK), and it means the
      // group is gone, in which case the flusher will drop the entry too.
      await storage
        .saveMessage(rebuilt.message, deviceKeyB64)
        .catch((e) =>
          appendLog(
            `[OUTBOX_MIRROR] Local copy of ${orphan.id.slice(0, 8)}… not saved: ${String(e)}`
          )
        );
    }
  }
  appendLog(`[OUTBOX_MIRROR] ${adopted}/${orphans.length} orphan entr(y/ies) adopted`);
  return adopted;
}
