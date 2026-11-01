/**
 * Sends the notification quick replies the iOS delegate handed to the page.
 *
 * A reply typed in a notification while this page holds the MLS state cannot be encrypted natively:
 * the foreground guard refuses it, and the entry the native side used to leave in
 * `outbox_pending.ndjson` was erased by this page's next `store_outbox_mirror` - the reply was lost
 * (review of #2843, F7). So `canari_push.mm` (`CanariHandQuickReplyToPage`) APPENDS it, sealed and
 * stamped with its account, to `pending_quick_replies.ndjson` and dispatches
 * {@link NATIVE_QUICK_REPLY_EVENT}; this module takes the signed-in account's lines
 * (`read_and_clear_pending_quick_replies`) and sends each through the composer's own path.
 *
 * NEVER LOST, NEVER TWICE:
 * - a line is taken only once a sender is registered (a signed-in session), and only that account's
 *   lines are handed over - another account's are dropped natively (A2);
 * - a line the sender could not queue is PUT BACK (`return_pending_quick_replies`) for the next take;
 * - a send that threw AFTER writing the message ({@link MessageWrittenError}) is owned, never put
 *   back - its queue sends it (A3);
 * - each reply is ACKNOWLEDGED (`acknowledge_quick_reply`): the native side holds the process and
 *   the notification response until then, so a suspended page gets the time to queue it (A1).
 *
 * One loss stays: a process that dies between the take (the file is claimed by a rename) and the
 * send's durable write loses the replies of that take. See `docs/wiki/frontend/mobile.md` ("One
 * notification delegate").
 */
import { appendLog } from '$lib/utils/sessionLog';
import { MessageWrittenError } from '$lib/utils/chat/messageWrittenError';

/** The event the native side dispatches when a reply waits. */
export const NATIVE_QUICK_REPLY_EVENT = 'canari:quick-reply';
export const TAKE_QUICK_REPLIES_COMMAND = 'read_and_clear_pending_quick_replies';
export const RETURN_QUICK_REPLIES_COMMAND = 'return_pending_quick_replies';
export const ACKNOWLEDGE_QUICK_REPLY_COMMAND = 'acknowledge_quick_reply';

export interface NativeQuickReply {
  /** The native side's id for this reply, which its acknowledgement names. */
  replyId: string;
  groupId: string;
  text: string;
  /** The notified message's `sentAt` (0 when unknown). */
  notifiedAt: number;
  /** When the user replied, stamped natively at the gesture. */
  repliedAt: number;
}

/** Sends one reply; true once the page owns it (queued, or a visible failed row). */
export type SendQuickReply = (reply: NativeQuickReply) => Promise<boolean>;

/** The signed-in session that sends: its account, whose replies alone it takes. */
export interface QuickReplySender {
  accountId: string;
  send: SendQuickReply;
}

/** The three native commands, injectable for tests. */
export interface QuickReplyStore {
  take(accountId: string): Promise<string[]>;
  putBack(lines: string[]): Promise<void>;
  acknowledge(replyId: string, queued: boolean): Promise<void>;
}

const tauriStore: QuickReplyStore = {
  async take(accountId) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<string[]>(TAKE_QUICK_REPLIES_COMMAND, { accountId });
  },
  async putBack(lines) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke(RETURN_QUICK_REPLIES_COMMAND, { lines });
  },
  async acknowledge(replyId, queued) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke(ACKNOWLEDGE_QUICK_REPLY_COMMAND, { replyId, queued });
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
    replyId: typeof r.replyId === 'string' ? r.replyId : '',
    groupId: r.groupId,
    text: r.text.trim(),
    notifiedAt: typeof r.notifiedAt === 'number' ? r.notifiedAt : 0,
    repliedAt: typeof r.repliedAt === 'number' ? r.repliedAt : 0,
  };
}

let sender: QuickReplySender | null = null;
let store: QuickReplyStore = tauriStore;

/** Tells the native side the page owns `reply` (or put it back); a failure only costs the hold. */
async function acknowledge(reply: NativeQuickReply, queued: boolean): Promise<void> {
  if (!reply.replyId) {
    appendLog(`[QuickReply] ERROR the reply to ${reply.groupId} carries no id - not acknowledged`);
    return;
  }
  try {
    await store.acknowledge(reply.replyId, queued);
  } catch (e) {
    appendLog(
      `[QuickReply] ERROR reply ${reply.replyId} not acknowledged - the native side holds it until iOS ends its time: ${String(e)}`
    );
  }
}

/**
 * Takes every waiting reply of the signed-in account and sends it; a reply not queued is put back.
 * Nothing is taken while no sender is registered: the file waits for the session.
 */
export async function drainNativeQuickReplies(why: string): Promise<void> {
  const current = sender;
  if (!current) {
    appendLog(`[QuickReply] ${why}: no signed-in session yet - the replies wait in their file`);
    return;
  }
  let lines: string[];
  try {
    lines = await store.take(current.accountId);
  } catch (e) {
    appendLog(`[QuickReply] ERROR the native replies could not be taken: ${String(e)}`);
    return;
  }
  if (lines.length === 0) return;
  appendLog(`[QuickReply] ${why}: ${lines.length} native reply(ies) taken`);
  const notSent: { line: string; reply: NativeQuickReply }[] = [];
  for (const line of lines) {
    const reply = parseNativeQuickReply(line);
    if (!reply) continue;
    let owned = false;
    try {
      owned = await current.send(reply);
    } catch (e) {
      if (e instanceof MessageWrittenError) {
        // Written, then failed: the message exists and its queue sends it. Putting the reply back
        // would send it a second time.
        appendLog(
          `[QuickReply] ERROR the reply to ${reply.groupId} was written, then threw - owned, not put back: ${e.message}`
        );
        owned = true;
      } else {
        appendLog(
          `[QuickReply] ERROR the reply to ${reply.groupId} threw before any write: ${String(e)}`
        );
      }
    }
    if (owned) {
      appendLog(`[QuickReply] reply to ${reply.groupId} queued by the page`);
      await acknowledge(reply, true);
    } else {
      notSent.push({ line, reply });
    }
  }
  if (notSent.length === 0) return;
  try {
    await store.putBack(notSent.map((n) => n.line));
    appendLog(`[QuickReply] ${notSent.length} reply(ies) not queued - put back for the next take`);
  } catch (e) {
    appendLog(
      `[QuickReply] ERROR ${notSent.length} reply(ies) not queued AND not put back - LOST: ${String(e)}`
    );
  }
  for (const { reply } of notSent) await acknowledge(reply, false);
}

/**
 * Registers THE sender (the signed-in session), or withdraws it with null. A registration drains at
 * once: a reply handed over before the session was up has been waiting for exactly this.
 */
export function setNativeQuickReplySender(next: QuickReplySender | null): void {
  sender = next;
  if (next) void drainNativeQuickReplies('session ready');
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
