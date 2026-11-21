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
 * "sending"; the acknowledgement moves that banner (answered only once the page holds it durably).
 *
 * A REPLY'S ID IS ITS MESSAGE ID (review of #3927): the send writes the reply under `replyId`, so the
 * page's own durable state - its outbox entry, its message row - says what became of a reply whose
 * acknowledgement never landed (a failed bridge, a reload between the write and the ack). The
 * replies a page life took and never settled ({@link UNCLAIMED_QUICK_REPLIES_COMMAND}) are settled
 * from that state at an account's first registration in a page life (before it takes anything) and
 * at its sign-out ({@link settleNativeQuickRepliesAtSignOut}): sent, pending or failed when the page
 * holds the reply, LOST only when it holds nothing of it. Never "lost" from the file alone - that
 * drew "retype it" over a reply that had been sent, and the member sent it twice.
 *
 * One loss stays: a process that dies between the take (the file is claimed by a rename) and the
 * send's durable write loses the replies of that take - on Android it is SAID, by that settlement.
 * See `docs/wiki/frontend/mobile.md` ("One notification delegate").
 */
import { appendLog } from '$lib/utils/sessionLog';
import { MessageWrittenError } from '$lib/utils/chat/messageWrittenError';
import { onAppForegroundChange } from '$lib/utils/appForeground';
import type { OutboxSettlement } from '$lib/utils/chat/outbox';

/** The event the native side dispatches when a reply waits. */
export const NATIVE_QUICK_REPLY_EVENT = 'canari:quick-reply';
export const TAKE_QUICK_REPLIES_COMMAND = 'read_and_clear_pending_quick_replies';
export const RETURN_QUICK_REPLIES_COMMAND = 'return_pending_quick_replies';
export const ACKNOWLEDGE_QUICK_REPLY_COMMAND = 'acknowledge_quick_reply';
export const UNCLAIMED_QUICK_REPLIES_COMMAND = 'unclaimed_quick_replies';

export interface NativeQuickReply {
  /**
   * The native side's id for this reply, which its acknowledgement names - and the MESSAGE ID its
   * send writes, so the page's durable state answers for it after a lost acknowledgement.
   */
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
  /** Sends the reply under `reply.replyId` as its message id. */
  send: SendQuickReply;
  /**
   * What the page HOLDS DURABLY of the message `replyId` names: its outbox entry (`pending`, or
   * `failed` when parked for the member), its message row (`sent`, or `failed` with an unsent
   * reason), or nothing (`null`). Throws when the store cannot be read - nothing is then decided.
   */
  heldAs: (replyId: string) => Promise<OutboxSettlement | null>;
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
  /**
   * Tells the native side, and answers whether it WAS told: false when no native listener knew the
   * reply (iOS: none registered; Android: no record of it, or the bridge failed). A loss it was not
   * told of is the page's to show.
   */
  acknowledge(replyId: string, outcome: QuickReplyOutcome): Promise<boolean>;
  /**
   * The ids of the replies of `accountId` a page life took and never settled (Android: recorded as
   * handed over, absent from the file). Empty on iOS, which holds each reply in the process that
   * handed it over. Rejects when the native side cannot say - nothing is then settled.
   */
  unclaimed(accountId: string): Promise<string[]>;
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
    return invoke<boolean>(ACKNOWLEDGE_QUICK_REPLY_COMMAND, { replyId, outcome });
  },
  async unclaimed(accountId) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<string[]>(UNCLAIMED_QUICK_REPLIES_COMMAND, { accountId });
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
/** The last sender registered, kept past its withdrawal: a sign-out settles ITS account's replies. */
let lastSender: QuickReplySender | null = null;
let store: QuickReplyStore = tauriStore;
/** Replies already shown as waiting or lost in this page life, so a re-take does not repeat it. */
const told = new Set<string>();
/** The accounts whose unclaimed replies this page life settled - once each, before their first take. */
const swept = new Set<string>();
/** Bumped by every registration, so a sweep that resolves after a newer one registers nothing. */
let registration = 0;
/**
 * The replies THIS page life took and has not settled yet: absent from the file and maybe not
 * written yet, so a settlement from durable state could call them lost while their send runs. A
 * sweep skips them; their own drain acknowledges them.
 */
const handling = new Set<string>();
/** The takes in flight: a sweep waits for them, so every reply they claim is in {@link handling}. */
const takes = new Set<Promise<string[]>>();
/**
 * The settlements, ONE AT A TIME: two weighing the same listing would acknowledge a reply twice,
 * and the second, finding no record left, would show a loss the banner already said.
 */
let settling: Promise<unknown> = Promise.resolve();

/** Who to show a reply that is not on its way: the session's toast. */
type Tell = QuickReplySender['tell'];

/**
 * Tells the native side what became of `replyId`, and answers whether it was told. Not told - no
 * listener knew the reply, or the bridge failed - is said at WARN: on Android the banner then stays
 * as it was until the next settlement, and a LOSS is the page's to show ({@link settleLost}).
 */
async function acknowledge(replyId: string, outcome: QuickReplyOutcome): Promise<boolean> {
  try {
    const nativeTold = await store.acknowledge(replyId, outcome);
    if (nativeTold) {
      appendLog(`[QuickReply] reply ${replyId} acknowledged: ${outcome}`);
    } else {
      appendLog(
        `[QuickReply] WARN reply ${replyId} acknowledged (${outcome}) and the native side was NOT told - no record or listener knew it`
      );
    }
    return nativeTold;
  } catch (e) {
    appendLog(
      `[QuickReply] ERROR reply ${replyId} not acknowledged (${outcome}) - the native side holds it until iOS ends its time: ${String(e)}`
    );
    return false;
  }
}

/**
 * A LOST reply, said on ONE surface: the native side shows its "not sent" notice for every reply it
 * is TOLD is lost, in front too (`CanariTellQuickReplyOutcome`, the Android banner), so the page
 * shows it only when the native side was not told - a line naming no id, an acknowledgement that
 * failed, or one the native side answered "not told" (review of #3927: that answer used to be
 * dropped, and a reply whose record was never written was lost with nobody saying so).
 */
async function settleLost(tell: Tell, replyId: string, reply: NativeQuickReply | null) {
  if (replyId && (await acknowledge(replyId, 'lost'))) return;
  if (!replyId)
    appendLog('[QuickReply] ERROR a reply line names no id - no hold can be released for it');
  appendLog(
    `[QuickReply] WARN reply ${replyId || '(no id)'} is LOST and the native side did not show it - the page shows it`
  );
  tellOnce(tell, 'lost', reply);
}

/** Shows a reply that is not on its way, once per reply and kind. */
function tellOnce(tell: Tell, kind: 'waiting' | 'lost', reply: NativeQuickReply | null) {
  const key = `${kind}:${reply?.replyId ?? ''}`;
  if (reply && told.has(key)) return;
  told.add(key);
  tell(kind, reply);
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
 * Claims the account's waiting lines. Every id claimed is in {@link handling} before the claim
 * resolves to anyone, so a sweep that waited for the takes in flight never weighs one of them.
 */
function take(accountId: string): Promise<string[]> {
  const claim = store.take(accountId).then((lines) => {
    for (const line of lines) {
      const id = replyIdOf(line);
      if (id) handling.add(id);
    }
    return lines;
  });
  takes.add(claim);
  const done = () => takes.delete(claim);
  claim.then(done, done);
  return claim;
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
    lines = await take(current.accountId);
  } catch (e) {
    appendLog(`[QuickReply] ERROR the native replies could not be taken: ${String(e)}`);
    return;
  }
  if (lines.length === 0) return;
  appendLog(`[QuickReply] ${why}: ${lines.length} native reply(ies) taken`);
  const notQueued: { line: string; reply: NativeQuickReply }[] = [];
  try {
    for (const line of lines) {
      const reply = parseNativeQuickReply(line);
      if (!reply) {
        // UNREADABLE IS LOST, AND SAID AT ONCE: the native hold of it would otherwise run to iOS's
        // end of the background time before the user hears of it.
        await settleLost(current.tell, replyIdOf(line), null);
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
        await settleLost(current.tell, reply.replyId, reply);
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
        await settleLost(current.tell, reply.replyId, reply);
        continue;
      }
      await acknowledge(reply.replyId, 'returned');
      tellOnce(current.tell, 'waiting', reply);
    }
  } finally {
    // Settled, put back or lost: none of them is this drain's any more.
    for (const line of lines) handling.delete(replyIdOf(line));
  }
}

/**
 * SETTLES THE REPLIES OF `from.accountId` A PAGE LIFE TOOK AND NEVER SETTLED, from what the page
 * holds durably ({@link QuickReplySender.heldAs}) - never from the file alone. A reply this life is
 * still sending is skipped ({@link handling}); the takes in flight are waited for first, so none of
 * theirs can be weighed. A reply whose state cannot be read is left: its record stays, and the next
 * settlement asks again. Answers how many were lost. Serialized ({@link settling}).
 */
function settleUnclaimed(from: QuickReplySender, why: string): Promise<number> {
  const run = settling.then(() => settleUnclaimedNow(from, why));
  settling = run.catch(() => undefined);
  return run;
}

/** The body of {@link settleUnclaimed}; never two at once. */
async function settleUnclaimedNow(from: QuickReplySender, why: string): Promise<number> {
  await Promise.allSettled(takes);
  let ids: string[];
  try {
    ids = await store.unclaimed(from.accountId);
  } catch (e) {
    appendLog(
      `[QuickReply] ERROR ${why}: the unclaimed replies could not be listed - none settled, asked again later: ${String(e)}`
    );
    return 0;
  }
  let lost = 0;
  for (const id of ids) {
    if (handling.has(id)) {
      appendLog(
        `[QuickReply] ${why}: reply ${id} is being sent by this page - its drain settles it`
      );
      continue;
    }
    let held: OutboxSettlement | null;
    try {
      held = await from.heldAs(id);
    } catch (e) {
      appendLog(
        `[QuickReply] ERROR ${why}: what the page holds of reply ${id} could not be read - not settled, its record kept: ${String(e)}`
      );
      continue;
    }
    if (held) {
      appendLog(`[QuickReply] ${why}: reply ${id} is held by the page (${held}) - settled so`);
      await acknowledge(id, held);
      continue;
    }
    lost++;
    appendLog(
      `[QuickReply] ERROR ${why}: reply ${id} was taken and the page holds nothing of it - LOST`
    );
    await settleLost(from.tell, id, null);
  }
  return lost;
}

/**
 * Registers THE sender (the signed-in session), or withdraws it with null. A registration drains at
 * once: a reply handed over before the session was up has been waiting for exactly this.
 *
 * THE FIRST REGISTRATION OF AN ACCOUNT IN THIS PAGE LIFE SETTLES WHAT AN EARLIER PAGE TOOK, BEFORE
 * ANY TAKE: the sender is set only once {@link settleUnclaimed} answered.
 */
export function setNativeQuickReplySender(next: QuickReplySender | null): void {
  const mine = ++registration;
  if (!next) {
    sender = null;
    return;
  }
  lastSender = next;
  if (swept.has(next.accountId)) {
    sender = next;
    void drainNativeQuickReplies('session ready');
    return;
  }
  sender = null;
  void (async () => {
    const lost = await settleUnclaimed(next, 'session ready');
    // Marked swept whatever the outcome, and only now: a registration meanwhile takes the slow path
    // too, so no take of this account starts while the listing is weighed. A failed listing is
    // asked again at the sign-out, or by the next page life.
    swept.add(next.accountId);
    if (lost > 0) {
      appendLog(`[QuickReply] ERROR ${lost} reply(ies) an earlier page took and never sent - LOST`);
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
 * THE SIGN-OUT OF `accountId` SETTLES ITS REPLIES (review of #3927): withdraws the sender - nothing
 * is taken from here on - then settles, from what the page still holds, every reply of that account
 * a page life took and never settled, so no banner says "sending" for an account nobody will open
 * again. `heldAs` reads the LEAVING account's store, captured before the session lets go of it
 * (`handleSignedOut`, which does not wait for this). The next registration of the account settles
 * again. Replies still waiting in the file stay there: the account's next session takes them, and
 * another account's take drops them, said.
 */
export async function settleNativeQuickRepliesAtSignOut(
  accountId: string,
  heldAs: QuickReplySender['heldAs']
): Promise<void> {
  registration++;
  sender = null;
  swept.delete(accountId);
  if (lastSender?.accountId !== accountId) {
    appendLog('[QuickReply] sign-out: no session of this account sent replies - nothing to settle');
    return;
  }
  const lost = await settleUnclaimed({ ...lastSender, heldAs }, 'sign-out');
  appendLog(`[QuickReply] sign-out: the account's unsettled replies are settled (${lost} lost)`);
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
  lastSender = null;
  told.clear();
  swept.clear();
  handling.clear();
  takes.clear();
  settling = Promise.resolve();
  registration = 0;
}
