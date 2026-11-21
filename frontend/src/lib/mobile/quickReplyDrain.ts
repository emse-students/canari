/**
 * Sends the notification quick replies the native side handed to the page.
 *
 * A reply typed in a notification while this page holds the MLS state cannot be encrypted natively:
 * the foreground guard refuses it, and the entry the native side used to leave in
 * `outbox_pending.ndjson` was erased by this page's next `store_outbox_mirror` - the reply was lost
 * (review of #2843, F7). So `canari_push.mm` (`CanariHandQuickReplyToPage`) APPENDS it, sealed and
 * stamped with the account the notification was addressed to, to `pending_quick_replies.ndjson` and
 * dispatches {@link NATIVE_QUICK_REPLY_EVENT}; this module takes the signed-in account's lines
 * (`read_and_clear_pending_quick_replies`) and sends each through the composer's own path.
 *
 * NEVER LOST, NEVER TWICE, NEVER SILENT:
 * - a line is taken only once a sender is registered (a signed-in session), and only that account's
 *   lines are handed over - another account's are dropped natively, and said (A2, M3);
 * - a line the sender could not queue is PUT BACK (`return_pending_quick_replies`) for the next take
 *   - the next native event, the next registration, or the app coming back to the front (M2) - and
 *   the page says it waits;
 * - a send that threw AFTER writing the message ({@link MessageWrittenError}) is owned, never put
 *   back - its queue sends it (A3, M1);
 * - each reply is ACKNOWLEDGED (`acknowledge_quick_reply`) with how the queue SETTLED it - sent,
 *   failed, still pending - never merely "queued": the native side holds the process and the
 *   notification response until then, and tells the user what is not sent (H1). A line that cannot
 *   be read is acknowledged lost at once, never left to run out the background time.
 *
 * ANDROID HANDS A REPLY OVER TOO, while the foreground guard holds (`CanariNotificationActionReceiver`,
 * `handReplyToPage`): the native encrypt would be refused there, and a reply left in the outbox
 * mirror sat queued until the app went to the background. Its receiver RECORDS the reply and draws it
 * "sending"; the acknowledgement moves that banner (answered only once the page holds it durably),
 * and a page life's FIRST registration of an account settles the replies an earlier, dead page took
 * ({@link SETTLE_UNCLAIMED_QUICK_REPLIES_COMMAND}) before it takes anything.
 *
 * One loss stays: a process that dies between the take (the file is claimed by a rename) and the
 * send's durable write loses the replies of that take - on Android it is SAID, by that sweep. See
 * `docs/wiki/frontend/mobile.md` ("One notification delegate").
 */
import { appendLog } from '$lib/utils/sessionLog';
import { MessageWrittenError } from '$lib/utils/chat/messageWrittenError';
import { onAppForegroundChange } from '$lib/utils/appForeground';

/** The event the native side dispatches when a reply waits. */
export const NATIVE_QUICK_REPLY_EVENT = 'canari:quick-reply';
export const TAKE_QUICK_REPLIES_COMMAND = 'read_and_clear_pending_quick_replies';
export const RETURN_QUICK_REPLIES_COMMAND = 'return_pending_quick_replies';
export const ACKNOWLEDGE_QUICK_REPLY_COMMAND = 'acknowledge_quick_reply';
export const SETTLE_UNCLAIMED_QUICK_REPLIES_COMMAND = 'settle_unclaimed_quick_replies';

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

/**
 * What became of one reply, as the native side is told it (`acknowledge_quick_reply`):
 * - `sent`: delivered;
 * - `failed`: out of the queue unsent - a failed row the page shows, with its retry;
 * - `pending`: queued and not sent yet (it waits for a retry);
 * - `returned`: not queued, put back in its file for a later take;
 * - `lost`: not sent and never will be (unreadable, its conversation removed, or not put back).
 */
export type QuickReplyOutcome = 'sent' | 'failed' | 'pending' | 'returned' | 'lost';

/** What the session's send answers: how the queue settled it, that it was not queued (a later take
 * retries it - a conversation not installed here yet among them), or that its conversation is
 * `gone` (removed - never retried). */
export type SendQuickReply = (
  reply: NativeQuickReply
) => Promise<'sent' | 'failed' | 'pending' | 'not-queued' | 'gone'>;

/** The signed-in session that sends: its account, whose replies alone it takes. */
export interface QuickReplySender {
  accountId: string;
  send: SendQuickReply;
  /**
   * Shows the member a reply that is NOT on its way: one put back to wait (its conversation not
   * loaded yet), or one lost that the native side could not be told of - it shows the others (M2).
   * Called once per reply and kind in this page life.
   */
  tell: (kind: 'waiting' | 'lost', reply: NativeQuickReply | null) => void;
}

/** The native commands, injectable for tests. */
export interface QuickReplyStore {
  take(accountId: string): Promise<string[]>;
  putBack(lines: string[]): Promise<void>;
  acknowledge(replyId: string, outcome: QuickReplyOutcome): Promise<void>;
  /**
   * Settles, as lost, the replies of `accountId` an earlier page life took and never acknowledged
   * (Android: its receiver records each one it hands over); answers how many. 0 on iOS, which holds
   * each reply in the process that handed it over.
   */
  settleUnclaimed(accountId: string): Promise<number>;
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
  async acknowledge(replyId, outcome) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke(ACKNOWLEDGE_QUICK_REPLY_COMMAND, { replyId, outcome });
  },
  async settleUnclaimed(accountId) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<number>(SETTLE_UNCLAIMED_QUICK_REPLIES_COMMAND, { accountId });
  },
};

/** The `replyId` a line names, read without trusting the rest of it; '' when it names none. */
export function replyIdOf(line: string): string {
  try {
    const parsed = JSON.parse(line) as { replyId?: unknown } | null;
    return typeof parsed?.replyId === 'string' ? parsed.replyId : '';
  } catch {
    return '';
  }
}

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
  if (typeof r.replyId !== 'string' || !r.replyId) {
    appendLog('[QuickReply] ERROR a native reply carries no id - dropped');
    return null;
  }
  if (typeof r.groupId !== 'string' || !r.groupId || typeof r.text !== 'string' || !r.text.trim()) {
    appendLog('[QuickReply] ERROR a native reply names no conversation or no text - dropped');
    return null;
  }
  return {
    replyId: r.replyId,
    groupId: r.groupId,
    text: r.text.trim(),
    notifiedAt: typeof r.notifiedAt === 'number' ? r.notifiedAt : 0,
    repliedAt: typeof r.repliedAt === 'number' ? r.repliedAt : 0,
  };
}

let sender: QuickReplySender | null = null;
let store: QuickReplyStore = tauriStore;
/** Replies already shown as waiting or lost in this page life, so a re-take does not repeat it. */
const told = new Set<string>();
/** The accounts whose unclaimed replies this page life settled - once each, before their first take. */
const swept = new Set<string>();
/** Bumped by every registration, so a sweep that resolves after a newer one registers nothing. */
let registration = 0;

/**
 * Tells the native side what became of `replyId`, and answers whether it was told. A failure costs
 * the hold, which then runs to iOS's end of the background time (on Android, the banner stays
 * "sending" until the next page life's sweep).
 */
async function acknowledge(replyId: string, outcome: QuickReplyOutcome): Promise<boolean> {
  try {
    await store.acknowledge(replyId, outcome);
    appendLog(`[QuickReply] reply ${replyId} acknowledged: ${outcome}`);
    return true;
  } catch (e) {
    appendLog(
      `[QuickReply] ERROR reply ${replyId} not acknowledged (${outcome}) - the native side holds it until iOS ends its time: ${String(e)}`
    );
    return false;
  }
}

/**
 * A LOST reply, said on ONE surface: the native side shows its "not sent" notice for every reply it
 * is told is lost, in front too (`CanariTellQuickReplyOutcome`, the Android banner), so the page
 * shows it only when the native side could not be told - a line naming no id, or an acknowledgement
 * that failed.
 */
async function settleLost(
  current: QuickReplySender,
  replyId: string,
  reply: NativeQuickReply | null
) {
  if (replyId && (await acknowledge(replyId, 'lost'))) return;
  if (!replyId)
    appendLog('[QuickReply] ERROR a reply line names no id - no hold can be released for it');
  tellOnce(current, 'lost', reply);
}

/** Shows a reply that is not on its way, once per reply and kind. */
function tellOnce(
  current: QuickReplySender,
  kind: 'waiting' | 'lost',
  reply: NativeQuickReply | null
) {
  const key = `${kind}:${reply?.replyId ?? ''}`;
  if (reply && told.has(key)) return;
  told.add(key);
  current.tell(kind, reply);
}

/** Sends one reply and answers how it ended; a throw before any write answers `not-queued`. */
async function sendOne(
  current: QuickReplySender,
  reply: NativeQuickReply
): Promise<'sent' | 'failed' | 'pending' | 'not-queued' | 'gone'> {
  try {
    return await current.send(reply);
  } catch (e) {
    if (e instanceof MessageWrittenError) {
      // Written, then failed: the message exists and its queue sends it. Putting the reply back
      // would send it a second time; it is pending until that queue settles it.
      appendLog(
        `[QuickReply] ERROR the reply to ${reply.groupId} was written, then threw - owned, not put back: ${e.message}`
      );
      return 'pending';
    }
    appendLog(
      `[QuickReply] ERROR the reply to ${reply.groupId} threw before any write: ${String(e)}`
    );
    return 'not-queued';
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
  const notQueued: { line: string; reply: NativeQuickReply }[] = [];
  for (const line of lines) {
    const reply = parseNativeQuickReply(line);
    if (!reply) {
      // UNREADABLE IS LOST, AND SAID AT ONCE: the native hold of it would otherwise run to iOS's
      // end of the background time before the user hears of it.
      await settleLost(current, replyIdOf(line), null);
      continue;
    }
    const outcome = await sendOne(current, reply);
    if (outcome === 'not-queued') {
      notQueued.push({ line, reply });
      continue;
    }
    if (outcome === 'gone') {
      // ITS CONVERSATION WILL NEVER TAKE IT (removed): LOST and said, never put
      // back - a put-back would come round on every take for ever (round-4 review of #2843).
      appendLog(
        `[QuickReply] ERROR the reply to ${reply.groupId} has no conversation to go to - LOST`
      );
      await settleLost(current, reply.replyId, reply);
      continue;
    }
    appendLog(`[QuickReply] reply to ${reply.groupId} settled by the page's queue: ${outcome}`);
    await acknowledge(reply.replyId, outcome);
  }
  if (notQueued.length === 0) return;
  let putBack = true;
  try {
    await store.putBack(notQueued.map((n) => n.line));
    appendLog(
      `[QuickReply] ${notQueued.length} reply(ies) not queued - put back for the next take`
    );
  } catch (e) {
    putBack = false;
    appendLog(
      `[QuickReply] ERROR ${notQueued.length} reply(ies) not queued AND not put back - LOST: ${String(e)}`
    );
  }
  for (const { reply } of notQueued) {
    if (!putBack) {
      await settleLost(current, reply.replyId, reply);
      continue;
    }
    await acknowledge(reply.replyId, 'returned');
    tellOnce(current, 'waiting', reply);
  }
}

/**
 * Registers THE sender (the signed-in session), or withdraws it with null. A registration drains at
 * once: a reply handed over before the session was up has been waiting for exactly this.
 *
 * THE FIRST REGISTRATION OF AN ACCOUNT IN THIS PAGE LIFE SETTLES WHAT A DEAD PAGE TOOK, BEFORE ANY
 * TAKE: the sender is set only once {@link QuickReplyStore.settleUnclaimed} answered, so no reply
 * this life has taken can be in flight while the native side weighs its record against the file.
 */
export function setNativeQuickReplySender(next: QuickReplySender | null): void {
  const mine = ++registration;
  if (!next) {
    sender = null;
    return;
  }
  if (swept.has(next.accountId)) {
    sender = next;
    void drainNativeQuickReplies('session ready');
    return;
  }
  sender = null;
  void (async () => {
    try {
      const lost = await store.settleUnclaimed(next.accountId);
      swept.add(next.accountId);
      if (lost > 0) {
        appendLog(
          `[QuickReply] ERROR ${lost} reply(ies) an earlier page took and never sent - LOST, their banners say so`
        );
      }
    } catch (e) {
      // Marked swept all the same: once this life has taken a reply, a sweep could say it lost
      // while it is in flight. The next page life asks again.
      swept.add(next.accountId);
      appendLog(
        `[QuickReply] ERROR the unclaimed replies could not be settled - asked again by the next page life: ${String(e)}`
      );
    }
    if (mine !== registration) {
      appendLog('[QuickReply] a newer registration came during the sweep - this one stands down');
      return;
    }
    sender = next;
    void drainNativeQuickReplies('session ready');
  })();
}

/**
 * Drains whenever the native side says a reply waits, and whenever the page comes back to the front
 * - a reply put back is sent by opening the app, as the notice the user saw promised (M2). The front
 * is the page's visibility (iOS) and the activity's own edge (`canari:foreground`, Android, whose
 * WebView never changes visibility). Returns the unsubscribe.
 */
export function listenForNativeQuickReplies(): () => void {
  const onReply = () => void drainNativeQuickReplies('the native side says a reply waits');
  const onVisible = () => {
    if (document.visibilityState === 'visible') void drainNativeQuickReplies('the app is in front');
  };
  window.addEventListener(NATIVE_QUICK_REPLY_EVENT, onReply);
  document.addEventListener('visibilitychange', onVisible);
  const stopForeground = onAppForegroundChange((foreground) => {
    if (foreground) void drainNativeQuickReplies('the app is in front');
  });
  return () => {
    window.removeEventListener(NATIVE_QUICK_REPLY_EVENT, onReply);
    document.removeEventListener('visibilitychange', onVisible);
    stopForeground();
  };
}

/** Test-only: replaces the native commands and forgets the sender and what was told. */
export function resetQuickReplyDrainForTest(s: QuickReplyStore): void {
  store = s;
  sender = null;
  told.clear();
  swept.clear();
  registration = 0;
}
