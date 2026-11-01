/**
 * Sends the notification quick replies the iOS delegate handed to the page.
 *
 * A reply typed in a notification while this page holds the MLS state cannot be encrypted natively:
 * the foreground guard refuses it, and the entry the native side used to leave in
 * `outbox_pending.ndjson` was erased by this page's next `store_outbox_mirror` - the reply was lost
 * (review of #2843, F7). So `canari_push.mm` (`CanariHandQuickReplyToPage`) APPENDS it to
 * `pending_quick_replies.ndjson` and dispatches {@link NATIVE_QUICK_REPLY_EVENT}; this module takes
 * the lines (`read_and_clear_pending_quick_replies`) and sends each through the composer's own path.
 *
 * NEVER LOST: a line is taken only once a sender is registered (a signed-in session), and a line the
 * sender could not queue is PUT BACK (`return_pending_quick_replies`) for the next take - the next
 * native event or the next registration. See `docs/wiki/frontend/mobile.md` ("One notification
 * delegate").
 */
import { appendLog } from '$lib/utils/sessionLog';

/** The event the native side dispatches when a reply waits. */
export const NATIVE_QUICK_REPLY_EVENT = 'canari:quick-reply';
export const TAKE_QUICK_REPLIES_COMMAND = 'read_and_clear_pending_quick_replies';
export const RETURN_QUICK_REPLIES_COMMAND = 'return_pending_quick_replies';

export interface NativeQuickReply {
  groupId: string;
  text: string;
  /** The notified message's `sentAt` (0 when unknown). */
  notifiedAt: number;
  /** When the user replied, stamped natively at the gesture. */
  repliedAt: number;
}

/** Sends one reply; true once the page owns it (queued, or a visible failed row). */
export type SendQuickReply = (reply: NativeQuickReply) => Promise<boolean>;

/** The two native commands, injectable for tests. */
export interface QuickReplyStore {
  take(): Promise<string[]>;
  putBack(lines: string[]): Promise<void>;
}

const tauriStore: QuickReplyStore = {
  async take() {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<string[]>(TAKE_QUICK_REPLIES_COMMAND);
  },
  async putBack(lines) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke(RETURN_QUICK_REPLIES_COMMAND, { lines });
  },
};

/** One line as the native side writes it, or null (said) when it is not one. */
export function parseNativeQuickReply(line: string): NativeQuickReply | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (e) {
    appendLog(`[QuickReply] ERROR a native reply line is not JSON - dropped: ${String(e)}`);
    return null;
  }
  const r = (parsed ?? {}) as Partial<Record<keyof NativeQuickReply, unknown>>;
  if (typeof r.groupId !== 'string' || !r.groupId || typeof r.text !== 'string' || !r.text.trim()) {
    appendLog('[QuickReply] ERROR a native reply names no conversation or no text - dropped');
    return null;
  }
  return {
    groupId: r.groupId,
    text: r.text.trim(),
    notifiedAt: typeof r.notifiedAt === 'number' ? r.notifiedAt : 0,
    repliedAt: typeof r.repliedAt === 'number' ? r.repliedAt : 0,
  };
}

let sender: SendQuickReply | null = null;
let store: QuickReplyStore = tauriStore;

/**
 * Takes every waiting reply and sends it; a reply not queued is put back. Nothing is taken while no
 * sender is registered: the file waits for the session.
 */
export async function drainNativeQuickReplies(why: string): Promise<void> {
  const send = sender;
  if (!send) {
    appendLog(`[QuickReply] ${why}: no signed-in session yet - the replies wait in their file`);
    return;
  }
  let lines: string[];
  try {
    lines = await store.take();
  } catch (e) {
    appendLog(`[QuickReply] ERROR the native replies could not be taken: ${String(e)}`);
    return;
  }
  if (lines.length === 0) return;
  appendLog(`[QuickReply] ${why}: ${lines.length} native reply(ies) taken`);
  const notSent: string[] = [];
  for (const line of lines) {
    const reply = parseNativeQuickReply(line);
    if (!reply) continue;
    let owned = false;
    try {
      owned = await send(reply);
    } catch (e) {
      appendLog(`[QuickReply] ERROR the reply to ${reply.groupId} threw: ${String(e)}`);
    }
    if (owned) {
      appendLog(`[QuickReply] reply to ${reply.groupId} queued by the page`);
    } else {
      notSent.push(line);
    }
  }
  if (notSent.length === 0) return;
  try {
    await store.putBack(notSent);
    appendLog(`[QuickReply] ${notSent.length} reply(ies) not queued - put back for the next take`);
  } catch (e) {
    appendLog(
      `[QuickReply] ERROR ${notSent.length} reply(ies) not queued AND not put back - LOST: ${String(e)}`
    );
  }
}

/**
 * Registers THE sender (the signed-in session), or withdraws it with null. A registration drains at
 * once: a reply handed over before the session was up has been waiting for exactly this.
 */
export function setNativeQuickReplySender(fn: SendQuickReply | null): void {
  sender = fn;
  if (fn) void drainNativeQuickReplies('session ready');
}

/** Drains whenever the native side says a reply waits. Returns the unsubscribe. */
export function listenForNativeQuickReplies(): () => void {
  const onReply = () => void drainNativeQuickReplies('the native side says a reply waits');
  window.addEventListener(NATIVE_QUICK_REPLY_EVENT, onReply);
  return () => window.removeEventListener(NATIVE_QUICK_REPLY_EVENT, onReply);
}

/** Test-only: replaces the native commands and forgets the sender. */
export function resetQuickReplyDrainForTest(s: QuickReplyStore): void {
  store = s;
  sender = null;
}
