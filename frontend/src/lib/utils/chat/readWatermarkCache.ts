/**
 * The read state a notification action produced while the app was not running.
 *
 * Acknowledging a conversation from the notification shade - "Marquer comme lu", or a quick reply,
 * which since 2026-08-31 means the same thing - is TWO facts, and only one of them travelled. The
 * `read_watermark` control frame the native side queues reaches peers and our own other devices
 * through the outbox. Nothing carried it to THIS device's database, whose conversation row is what
 * draws the badge: the user acknowledged a conversation from the shade, opened the app, and found
 * it unread again - indistinguishable from the action having done nothing.
 *
 * So the native action also writes `read_watermarks.ndjson`, one line per conversation, and this
 * module merges it at login. The merge is `max` on both ends, so a line replayed or arriving out of
 * order cannot move the watermark backwards.
 */

import type { Conversation } from '$lib/types';
import { appendLog } from '$lib/utils/sessionLog';
import { isTauriRuntime } from '$lib/utils/openExternal';
import { countUnreadForUser, mergeReadWatermark, readPointFor } from './readState';

/**
 * One line of `read_watermarks.ndjson`, written by `appendReadWatermark`
 * (CanariFirebaseMessagingService.kt) and its iOS twin `CanariAppendReadWatermark`
 * (canari_push.mm).
 */
export interface NativeReadWatermark {
  groupId: string;
  /** The SENDER's `sentAt` for the newest message that notification was about, in ms. */
  at: number;
  /**
   * The SERVER's `createdAt` of that same message, in ms - the clock the conversation is ordered
   * and read on (readState.ts). Written by Android since the owner's decision of 2026-10-31; absent
   * from an iOS line and from one an older build wrote, which then moves the stamped mark alone.
   */
  serverAt?: number;
}

/** A positive, finite instant in ms, floored; `undefined` for anything else. */
function instantOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/**
 * Applies native read watermarks to `conversations` in memory and returns the keys that changed.
 *
 * Split out from the invoke so it can be tested without a Tauri runtime, and because the ordering
 * it encodes is the part worth pinning: the watermark is merged FIRST, and `unreadCount` is then
 * recomputed FROM it. Writing the count directly would be a second copy of the same fact - one
 * that a later history load, which recomputes from the watermark, would silently contradict.
 *
 * Matches on `conversation.id`, never on the map key: the two coincide for MLS groups today, and
 * a reader that assumes they always will is one refactor away from silently merging nothing.
 */
export function applyNativeReadWatermarks(
  entries: NativeReadWatermark[],
  conversations: Map<string, Conversation>,
  userId: string
): string[] {
  const meNorm = userId.toLowerCase();
  const changed: string[] = [];
  // Collapse first: the file is already one line per conversation, but nothing about the format
  // guarantees it, and two lines for one group must not cost two merges and two saves.
  const highest = new Map<string, { at: number; serverAt: number }>();
  for (const e of entries) {
    const at = instantOf(e?.at);
    if (!e?.groupId || at === undefined) {
      appendLog(
        `[READ_WATERMARK] Entry skipped (not a watermark): ${JSON.stringify(e).slice(0, 80)}`
      );
      continue;
    }
    const held = highest.get(e.groupId);
    highest.set(e.groupId, {
      at: Math.max(held?.at ?? 0, at),
      serverAt: Math.max(held?.serverAt ?? 0, instantOf(e.serverAt) ?? 0),
    });
  }
  if (highest.size === 0) return changed;

  for (const [key, convo] of conversations.entries()) {
    const mark = highest.get(convo.id);
    if (mark === undefined) continue;
    // TWO CLOCKS, EACH INTO ITS OWN MAP (readState.ts): `at` is the `sentAt` of the newest message
    // the banner showed, `serverAt` the server's `createdAt` of that same message when the line
    // carries it. Either one moving is a change.
    const stamped = mergeReadWatermark(convo.readWatermarks, meNorm, mark.at);
    const server =
      mark.serverAt > 0
        ? mergeReadWatermark(convo.serverReadWatermarks, meNorm, mark.serverAt)
        : null;
    if (!stamped && !server) continue;
    const next = {
      ...convo,
      ...(stamped ? { readWatermarks: stamped } : {}),
      ...(server ? { serverReadWatermarks: server } : {}),
    };
    const mine = readPointFor(next, meNorm);
    conversations.set(key, {
      ...next,
      unreadCount: countUnreadForUser(convo.messages, mine.stamped, mine.server),
    });
    changed.push(key);
    appendLog(
      `[READ_WATERMARK] ${convo.id.slice(0, 8)} read up to ${new Date(mark.at).toISOString()}${mark.serverAt > 0 ? ` (server ${new Date(mark.serverAt).toISOString()})` : ' (no server time on the line)'}`
    );
  }
  return changed;
}

/**
 * Reads the native read-watermark hand-off (Tauri only), applies it, and persists what moved.
 *
 * No-op on web/desktop: there is no notification shade there for an action to fire from. Called at
 * login, after the conversations are loaded and after `consumeFcmCache`, so the messages this
 * watermark covers are already in memory and the recomputed `unreadCount` is the final one.
 *
 * @returns the number of conversations whose read state advanced.
 */
export async function consumeNativeReadWatermarks(
  conversations: Map<string, Conversation>,
  userId: string,
  saveConversation: (key: string) => Promise<void>
): Promise<number> {
  if (!isTauriRuntime()) return 0;

  let entries: NativeReadWatermark[];
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    entries = await invoke<NativeReadWatermark[]>('read_and_clear_read_watermarks');
  } catch (e) {
    appendLog(`[READ_WATERMARK] Read failed: ${String(e)}`);
    return 0;
  }
  if (!entries.length) return 0;

  const changed = applyNativeReadWatermarks(entries, conversations, userId);
  // The read state lives on the conversation row, so this save is what makes it survive the
  // reload - the same reason the foreground path persists its optimistic merge rather than
  // leaving it in memory.
  await Promise.all(
    changed.map((key) =>
      saveConversation(key).catch((e) =>
        appendLog(`[READ_WATERMARK] ${key.slice(0, 8)} not persisted: ${String(e)}`)
      )
    )
  );
  appendLog(
    `[READ_WATERMARK] ${changed.length}/${entries.length} conversation(s) advanced from the shade`
  );
  return changed.length;
}
