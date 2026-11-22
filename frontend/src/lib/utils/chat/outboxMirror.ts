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
 * appends it here, so an entry the background drain could NOT deliver exists only in this file.
 * **THE FILE HAS TWO WRITERS AND SAYS WHICH LINE IS WHOSE** (`outbox_mirror.rs`, 2026-11-21): the
 * page writes ITS lines only, stamped `owner: "page"`, under the lock the native writers take, and
 * keeps every other line - so a warm page in the background no longer erases a reply typed in the
 * shade with its next mutation. `adoptOrphanedMirrorEntries()` then turns every native line the TS
 * outbox does not know about into a real outbox entry (plus the local message the sender never got),
 * at login AND whenever the page returns to the front (`OutboxController.adoptNativeEntries`), so the
 * ordinary flusher owns it from then on. It is the symmetric twin of `reconcileOutboxSent`.
 */

import type { IStorage, OutboxEntry, StoredMessage } from '$lib/db';
import { asNativeRefusal } from '$lib/db/outboxCodec';
import {
  MAX_CONSECUTIVE_SERVER_ERRORS,
  buildOutboxProto,
  deliveryForOutboxEntry,
  isServerFailureTerminal,
  ownRowOfQueuedText,
} from '$lib/utils/chat/outbox';
import { decodeAppMessage } from '$lib/proto/codec';
import { fromBase64, toBase64 } from '$lib/utils/hex';
import { isTauriRuntime } from '$lib/utils/openExternal';
import { appendLog } from '$lib/utils/sessionLog';
import { showToast } from '$lib/stores/toast.svelte';
import { m } from '$lib/paraglide/messages';
import type { Conversation } from '$lib/types';
import { replaceMessageOrdered } from './messageOrder';
import { noteServerTime } from './serverClock';

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
  /**
   * Set by the native drain only (`OutboxMirrorEntry.unsendable`): it learned this entry will NEVER
   * go from there - the server refused it, its group is not held, it is malformed. The drains skip
   * it and keep it, and so does this side's write; adopted, a text or a reply is parked as FAILED,
   * with its Retry ({@link adoptMirrorEntry}). Never written by this side.
   */
  unsendable?: boolean;
  /**
   * WHY the native drain marked the line {@link unsendable}, typed where the answer was read
   * (`UnsendableCause` in the Android service): `refused` or `not_encryptable`. Absent on a line a
   * build before the field marked - adopted then as `unrecorded`, never guessed. Carried by the
   * page's write like the mark itself (`NATIVE_VERDICTS`, `outbox_mirror.rs`).
   */
  unsendableCause?: string;
  /**
   * `"page"` on every line this side wrote - stamped by `store_outbox_mirror`, not here. Absent on a
   * line the native side queued, and on one written before the stamp existed: both are adopted, and
   * both are kept by this side's write until its queue holds them.
   */
  owner?: 'page';
}

/** Project a queued entry to its mirror form, or null if it cannot be mirrored (media, no proto). */
export function toMirrorEntry(entry: OutboxEntry): OutboxMirrorEntry | null {
  // A text FAILED on 5xx waits for its author's Retry: the background sender must not send what the
  // bubble shows as failed.
  if (isServerFailureTerminal(entry)) return null;
  // buildOutboxProto returns null for media (foreground upload only) and the verbatim proto for
  // text/reply and control (reaction/edit/delete/read). Control is mirrored now that C1/C2 make
  // background mls.bin writes safe - notably `delete`, so a retraction is not stuck behind an
  // already-sent body until the app reopens.
  // A REPLY IS MIRRORED QUOTING BY ID ONLY. Whether its quote text may leave is decided against the
  // server's exclusion windows (`decideQuote` in `outbox.ts`), which the native sender does not read;
  // so the copy it may send is the one that is always allowed. The foreground flush, which decides,
  // sends the text whenever it is entitled - and whichever copy lands first, the id is the same.
  const mirrored =
    entry.kind === 'reply' && entry.replyTo?.preview
      ? { ...entry, replyTo: { ...entry.replyTo, preview: '' } }
      : entry;
  const proto = buildOutboxProto(mirrored);
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

/** The page's mirror writes, in the order they were asked for ({@link syncOutboxMirror}). */
let mirrorWrites: Promise<boolean> = Promise.resolve(true);

/**
 * Native-looking lines {@link adoptOrphanedMirrorEntries} found ALREADY SENT by their stored row:
 * held by the page's next mirror write, which drops them, so the background drain never sends them
 * again. Forgotten once a write holding them lands.
 */
const sentNativeLines = new Set<string>();

/**
 * Native lines left unadopted because their conversation is not stored on this device yet, by line
 * id, with that conversation: the line saying so is written once per page life, and the write of
 * that conversation's row adopts them ({@link nativeLinesWaitFor}, `conversationStored.ts`).
 */
const waitingForConversation = new Map<string, string>();

/**
 * Replaces the waiting lines with those a pass that READ the mirror found waiting, and hands back
 * `result`. A pass that could not read it changes nothing: it learned nothing.
 */
function settleWaiting<T>(found: Map<string, string>, result: T): T {
  waitingForConversation.clear();
  for (const [id, groupId] of found) waitingForConversation.set(id, groupId);
  return result;
}

/**
 * Whether a native line was left unadopted for want of `conversationId`'s row - so its write is
 * what adopts it. Read by the outbox controller on every row written: a map scan, no I/O.
 */
export function nativeLinesWaitFor(conversationId: string): boolean {
  for (const groupId of waitingForConversation.values()) {
    if (groupId === conversationId) return true;
  }
  return false;
}

/** Whether a mirror line found already sent still waits for the write that drops it. */
export function mirrorHoldsSentLines(): boolean {
  return sentNativeLines.size > 0;
}

/**
 * THE MEMBER IS TOLD WHEN A QUEUED LINE COULD NOT BE READ BACK (principle 2: the essential is never
 * lost silently). `count` is what the native side's fold found unreadable - a line that is no entry,
 * or a file moved aside it could not open (`outbox_mirror.rs`) - and a log line alone is read by
 * nobody: the member may have a message to type again.
 */
function reportUnreadableLines(count: number, where: string): void {
  if (count <= 0) return;
  console.error(
    `[OUTBOX_MIRROR] ${where}: ${count} queued line(s) or file(s) could not be read back - the member is told`
  );
  showToast(m.chat_outbox_lines_unreadable({ count }), 'error', 8000);
}

/**
 * Write the page's lines of the native mirror from an outbox snapshot (Tauri only; no-op on
 * web/desktop-web). Called after every outbox mutation so the background service always sees the
 * live queue. `entries` is the WHOLE queue: what it mirrors is written, and every id in it is
 * `held` - a native line under a held id is the page's, mirrored or not (a failed text is not).
 * Every other native line is kept (`outbox_mirror.rs`).
 *
 * **ONE AT A TIME, IN THE ORDER ASKED.** The command waits for the native writers' lock, which a
 * background drain holds through its POSTs, so two writes in flight could land in either order and
 * the older snapshot win. Each write starts when the previous one ended.
 *
 * @returns whether the write landed; a failure is logged here.
 */
export function syncOutboxMirror(entries: OutboxEntry[]): Promise<boolean> {
  if (!isTauriRuntime()) return Promise.resolve(true);
  const mirror = entries.map(toMirrorEntry).filter((e): e is OutboxMirrorEntry => e !== null);
  const settled = [...sentNativeLines];
  const held = [...entries.map((e) => e.id), ...settled];
  const write = mirrorWrites.then(async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const unreadable = await invoke<number>('store_outbox_mirror', { entries: mirror, held });
      for (const id of settled) sentNativeLines.delete(id);
      reportUnreadableLines(unreadable, 'mirror write');
      return true;
    } catch (e) {
      appendLog(`[OUTBOX_MIRROR] Mirror write failed (${mirror.length} entries): ${String(e)}`);
      return false;
    }
  });
  mirrorWrites = write;
  return write;
}

/**
 * One line of `outbox_sent.ndjson`: `id`, or `id<TAB>receivedAt` from a native build that reads the
 * server's answer (`CanariFirebaseMessagingService.appendOutboxSent`). `receivedAt` is absent when
 * the line has none - an older native build, or a server that answered no receive time.
 */
export function parseOutboxSentLine(line: string): { id: string; receivedAt?: number } | null {
  const [id, at] = line.trim().split('\t');
  if (!id) return null;
  const receivedAt = Number(at);
  return Number.isFinite(receivedAt) && receivedAt > 0 ? { id, receivedAt } : { id };
}

/**
 * Drain `outbox_sent.ndjson` (messageIds the background service already delivered) and delete the
 * matching outbox entries. Tauri only; no-op elsewhere. Idempotent: deleting an absent entry is a
 * no-op, and a duplicate send is deduplicated by the receiver.
 *
 * A LINE THAT CARRIES THE SERVER'S RECEIVE TIME DATES THE AUTHOR'S OWN COPY, as a foreground send
 * does (`patchServerTimestamp` in outbox.ts): the stored row takes it as `serverTimestamp`, and
 * `onDated` hands it to the rows already in memory. Without it the copy is ordered by its `sentAt`
 * (`messageTime`), the only clock it has.
 */
export async function reconcileOutboxSent(
  storage: IStorage,
  dating?: {
    deviceKeyB64: string;
    /** The account the receive times are noted for (`serverClock.ts`). */
    userId: string;
    onDated?: (messageId: string, receivedAt: number) => void;
  }
): Promise<void> {
  if (!isTauriRuntime()) return;
  let lines: string[];
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    lines = await invoke<string[]>('read_and_clear_outbox_sent');
  } catch (e) {
    appendLog(`[OUTBOX_MIRROR] outbox_sent read failed: ${String(e)}`);
    return;
  }
  const sent = lines.map(parseOutboxSentLine).filter((l) => l !== null);
  if (!sent.length) return;
  const dated = sent.filter((l) => l.receivedAt !== undefined).length;
  appendLog(
    `[OUTBOX_MIRROR] ${sent.length} message(s) sent in the background to reconcile, ${dated} with the server's receive time`
  );
  // The conversation each sent id was queued in, read from the outbox BEFORE its entries go: the
  // dating below is a write scoped to that conversation, like every rewrite of a stored row.
  const queuedIn = new Map<string, string>();
  if (dating) {
    try {
      for (const e of await storage.getOutboxQueue(dating.deviceKeyB64)) {
        queuedIn.set(e.id, e.conversationId);
      }
    } catch (e) {
      appendLog(`[OUTBOX_MIRROR] outbox read failed, background sends left undated: ${String(e)}`);
    }
  }
  for (const { id, receivedAt } of sent) {
    if (dating) noteServerTime(dating.userId, receivedAt);
    await storage
      .deleteOutboxEntry(id)
      .catch((e) =>
        appendLog(
          `[OUTBOX_MIRROR] could not drop background-sent ${id} from the outbox: ${String(e)}`
        )
      );
    if (receivedAt === undefined || !dating) continue;
    const conversationId = queuedIn.get(id);
    if (!conversationId) {
      appendLog(
        `[OUTBOX_MIRROR] background-sent ${id.slice(0, 8)}… was no longer queued - left undated (it keeps its sentAt)`
      );
      continue;
    }
    // A control frame's id names no stored row: `updateMessage` is then a no-op.
    await storage
      .updateMessage(conversationId, id, { serverTimestamp: receivedAt }, dating.deviceKeyB64)
      .then(() => dating.onDated?.(id, receivedAt))
      .catch((e) =>
        appendLog(
          `[OUTBOX_MIRROR] background-sent ${id.slice(0, 8)}… not dated (it keeps its sentAt): ${String(e)}`
        )
      );
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
 *
 * AN ENTRY THE NATIVE DRAIN MARKED UNSENDABLE IS ADOPTED FAILED, NEVER DROPPED (principle 2): a text
 * or a reply is parked at the terminal count ({@link MAX_CONSECUTIVE_SERVER_ERRORS}), so the bubble
 * shows it failed with its Retry and the flusher does not send it on its own - the member decides.
 * A control frame has no bubble to show it on: it is adopted pending, and the flusher's own answer
 * to it decides.
 */
export function adoptMirrorEntry(
  entry: OutboxMirrorEntry,
  userId: string
): AdoptedMirrorEntry | null {
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
    adoptedFromMirror: true as const,
  };
  // Typed entries only: a control frame has no Retry to park it behind.
  // The cause travels with the entry, so its failure is said as what it was - never as the 5xx run
  // its parked count otherwise reads as.
  const parked = entry.unsendable
    ? (() => {
        const nativeRefusal = asNativeRefusal(entry.unsendableCause) ?? 'unrecorded';
        return { serverErrors: MAX_CONSECUTIVE_SERVER_ERRORS, nativeRefusal };
      })()
    : {};

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
    const outbox: OutboxEntry = {
      ...base,
      ...parked,
      kind: 'reply',
      text: app.reply.content ?? '',
      replyTo,
    };
    return { outbox, message: ownRowOfQueuedText(outbox, userId) };
  }
  if (app?.text?.content !== undefined) {
    const outbox: OutboxEntry = { ...base, ...parked, kind: 'text', text: app.text.content ?? '' };
    return { outbox, message: ownRowOfQueuedText(outbox, userId) };
  }
  appendLog(
    `[OUTBOX_MIRROR] Orphan ${entry.id.slice(0, 8)}… is neither text nor reply - cannot adopt it`
  );
  return null;
}

/** Which side a start pass could not read: the native mirror file, or the page's own queue. */
export type MirrorAdoptionSide = 'mirror' | 'queue';

/**
 * THE MEMBER IS TOLD WHEN A START PASS CANNOT RUN, once per run of failures, in the words of the
 * side that failed. `mirror`: what was queued from the notifications is held - drawn failed, with its
 * Retry - and what the member sends from the app still goes. `queue`: the page's own queue cannot be
 * read, so nothing queued on this device can be compared or sent until it reads again.
 */
export function reportNativeQueueUnreachable(held: number, side: MirrorAdoptionSide): void {
  console.error(
    `[OUTBOX_MIRROR] start pass blocked on the ${side} - ${held} adopted entr(y/ies) held, the member is told`
  );
  showToast(
    side === 'queue' ? m.chat_outbox_queue_unreadable() : m.chat_outbox_native_queue_unreachable(),
    'error',
    8000
  );
}

/**
 * The adoption could not read what it decides on - the mirror, or the queue it compares it with.
 * THROWN, never answered as "nothing to adopt": the controller's start pass that sees it did not
 * run, and runs again (`claimAtStart` in outbox.ts). `side` is the TYPED discriminator the member's
 * message is chosen from - never the error's text.
 */
export class MirrorAdoptionError extends Error {
  constructor(
    readonly side: MirrorAdoptionSide,
    cause: unknown
  ) {
    super(`the ${side} could not be read: ${String(cause)}`);
    this.name = 'MirrorAdoptionError';
  }
}

/**
 * The page's claims on native mirror lines, kept by the outbox controller (`unclaimed` in
 * outbox.ts). `hold` is called BEFORE an adopted entry is written to the queue - so no flush can
 * read it before it is held - and for every native line the queue ALREADY holds (adopted by an
 * earlier page life whose claim never landed: the mirror is the durable record of that). `release`
 * undoes a hold whose queue write failed.
 */
export interface MirrorClaims {
  hold(id: string): void;
  release(id: string): void;
}

/**
 * Adopt into the TypeScript outbox every NATIVE mirror line it does not already know about, and
 * persist the local copy of each so the sender finally sees what they sent. Tauri only; no-op
 * elsewhere.
 *
 * At login it runs BEFORE conversations are loaded: the adopted message is written to the store and
 * picked up by the ordinary history load, which is also what gives it its `pending` status. On a
 * return to the front the controller puts it on screen itself (`OutboxController.adoptNativeEntries`).
 *
 * A LINE THE PAGE WROTE IS NEVER ADOPTED: absent from the queue, the page settled it - sent,
 * withdrawn, discarded - after the last write that named it, and the next write drops it.
 *
 * A delivered background send is removed from the mirror by the native drain, so an entry still
 * present here was NOT delivered. Should one race through anyway, `reconcileOutboxSent` deletes it
 * moments later - adoption is idempotent on the stable messageId either way.
 */
export async function adoptOrphanedMirrorEntries(
  storage: IStorage,
  deviceKeyB64: string,
  userId: string,
  claims?: MirrorClaims
): Promise<string[]> {
  if (!isTauriRuntime()) return [];
  // THIS PASS'S OWN WAITING LINES: a line that left the mirror (sent by a drain), was found sent, or
  // could not be adopted is in none, so it stops naming its conversation (review of #3969, N1).
  const stillWaiting = new Map<string, string>();
  let mirror: OutboxMirrorEntry[];
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    // The read FOLDS first: the native journal and every file moved aside unreadable are taken into
    // the mirror before it is read, and what still cannot be read is counted (`outbox_mirror.rs`).
    const read = await invoke<{ entries: OutboxMirrorEntry[]; unreadable: number }>(
      'read_outbox_mirror'
    );
    mirror = read.entries;
    reportUnreadableLines(read.unreadable, 'mirror read');
  } catch (e) {
    appendLog(`[OUTBOX_MIRROR] Mirror read failed: ${String(e)}`);
    throw new MirrorAdoptionError('mirror', e);
  }
  if (!mirror.length) return settleWaiting(stillWaiting, []);

  const queued = await storage
    .getOutboxQueue(deviceKeyB64)
    .then((entries) => new Map(entries.map((e) => [e.id, e])))
    .catch((e) => {
      // Treating a failed read as an empty queue here would re-adopt the whole live queue, so this
      // is the one branch that must give up rather than guess - and say so to its caller.
      appendLog(`[OUTBOX_MIRROR] Outbox read failed, adoption skipped: ${String(e)}`);
      throw new MirrorAdoptionError('queue', e);
    });
  const known = new Set(queued.keys());

  // NATIVE LINES THE QUEUE ALREADY HOLDS: adopted by a page life whose claim never landed (it is in
  // memory only). Still native in the file, so a background drain may send them - held again.
  const unclaimedNative = mirror.filter((e) => e.id && e.owner !== 'page' && known.has(e.id));
  if (claims && unclaimedNative.length) {
    for (const line of unclaimedNative) claims.hold(line.id);
    appendLog(
      `[OUTBOX_MIRROR] ${unclaimedNative.length} queued entr(y/ies) still native in the mirror - held until claimed`
    );
    // MARKED AS ADOPTED, DURABLY: an entry adopted before the mark existed carries none, and a later
    // start pass that fails holds only marked entries - this one, still native, would be sent.
    for (const line of unclaimedNative) {
      if (queued.get(line.id)?.adoptedFromMirror) continue;
      await storage
        .updateOutboxEntry(line.id, { adoptedFromMirror: true }, deviceKeyB64)
        .then(() =>
          appendLog(`[OUTBOX_MIRROR] ${line.id.slice(0, 8)}… still native, marked as adopted`)
        )
        .catch((e) =>
          appendLog(
            `[OUTBOX_MIRROR] ${line.id.slice(0, 8)}… still native, NOT marked as adopted (a failed start pass would not hold it): ${String(e)}`
          )
        );
    }
  }

  const stale = mirror.filter((e) => e.owner === 'page' && !known.has(e.id));
  if (stale.length) {
    appendLog(
      `[OUTBOX_MIRROR] ${stale.length} line(s) the page wrote and no longer queues - not adopted, the next write drops them`
    );
  }
  const orphans = mirror.filter((e) => e.id && e.owner !== 'page' && !known.has(e.id));
  if (!orphans.length) return settleWaiting(stillWaiting, []);
  appendLog(`[OUTBOX_MIRROR] ${orphans.length} orphan mirror entr(y/ies) to adopt`);

  const adopted: string[] = [];
  for (const orphan of orphans) {
    // ALREADY SENT, BY ITS STORED ROW: a line a page wrote before the `owner` stamp (1.7.3) reads as
    // native, and one whose send landed after the page's last mirror write is still in the file. The
    // row the send dated (`serverTimestamp`, `authorship`) is the durable proof - never the server's
    // dedup. A control frame has no row: it is adopted, and its receiver applies it idempotently.
    const stored = await storage.getMessage(orphan.id, deviceKeyB64).catch((e) => {
      appendLog(
        `[OUTBOX_MIRROR] Orphan ${orphan.id.slice(0, 8)}… row not read - adopted on the line alone: ${String(e)}`
      );
      return null;
    });
    if (stored && (stored.serverTimestamp || stored.authorship)) {
      appendLog(
        `[OUTBOX_MIRROR] Orphan ${orphan.id.slice(0, 8)}… is already sent by its stored row - not adopted, the next write drops it`
      );
      sentNativeLines.add(orphan.id);
      continue;
    }
    const rebuilt = adoptMirrorEntry(orphan, userId);
    if (!rebuilt) continue;
    // THE ROW FIRST, THE ENTRY SECOND, AND NO ENTRY WITHOUT ITS ROW. The entry was queued first and
    // the row written "best-effort" after it: a row the store refused (its conversation not stored
    // yet - the foreign key) left an entry with nothing to show, parked failed for ever, its text
    // invisible and undeletable (Mi 9T, 1.7.3-alpha.6). Here the line is the durable record until
    // the queue holds it, so a tear between the two writes leaves the row, and the line adopts it
    // at the next pass; and a conversation not stored is read as the fact it is, never learnt from
    // the refusal - the line waits, still native, for a pass that finds it stored.
    if (rebuilt.message) {
      const stored = await storage.getConversation(orphan.groupId).catch((e) => {
        appendLog(
          `[OUTBOX_MIRROR] Orphan ${orphan.id.slice(0, 8)}… its conversation not read - not adopted yet, the line stays native: ${String(e)}`
        );
        return undefined;
      });
      if (stored === undefined) {
        // A read that failed proves nothing: a line already waiting keeps waiting - its row-write
        // trigger, and its WARN said once.
        if (waitingForConversation.has(orphan.id)) stillWaiting.set(orphan.id, orphan.groupId);
        continue;
      }
      if (stored === null) {
        // Said ONCE per page life, and truthfully: the write of that row adopts it - a Welcome, a
        // discovery, a restore. A conversation this device deleted is never written again, and what
        // its line then becomes is an open question (`open-questions.md`, "A native line naming a
        // conversation this device no longer stores").
        if (!waitingForConversation.has(orphan.id)) {
          console.warn(
            `[OUTBOX_MIRROR] Orphan ${orphan.id.slice(0, 8)}… names ${orphan.groupId.slice(0, 8)}…, which this device does not store - not adopted, kept native in the mirror; adopted when that conversation's row is written, never if it was deleted here`
          );
        }
        stillWaiting.set(orphan.id, orphan.groupId);
        continue;
      }
    }
    // HELD BEFORE IT IS QUEUED: a flush reading the queue between the write and the hold would send
    // a line the background drain may send too.
    claims?.hold(orphan.id);
    try {
      if (rebuilt.message) {
        // Written only where no row stands: a row already stored under this id is the truth, never
        // replaced by this rebuild.
        const written = await storage.saveMessagesIfAbsent([rebuilt.message], deviceKeyB64);
        if (!written.has(orphan.id)) {
          appendLog(
            `[OUTBOX_MIRROR] Local copy of ${orphan.id.slice(0, 8)}… already stored - left as it is`
          );
        }
      }
      await storage.saveOutboxEntry(rebuilt.outbox, deviceKeyB64);
    } catch (e) {
      claims?.release(orphan.id);
      appendLog(
        `[OUTBOX_MIRROR] Adoption of ${orphan.id.slice(0, 8)}… failed, the line stays native for the next pass: ${String(e)}`
      );
      continue;
    }
    // THE ONE TIME THIS PARK IS ACCUSED, at the commit point: once the queue holds the entry, the
    // flusher reads it back as carried forward, so no pass or restart says it again. The builder
    // stays pure - a pass that waits or fails to write has adopted nothing and says nothing.
    if (rebuilt.outbox.nativeRefusal) {
      const line = `[OUTBOX_MIRROR] Orphan ${orphan.id.slice(0, 8)}… was marked unsendable by the native drain (${rebuilt.outbox.nativeRefusal}) - adopted failed, with its Retry`;
      console.error(line);
      appendLog(line);
    }
    adopted.push(orphan.id);
  }
  appendLog(`[OUTBOX_MIRROR] ${adopted.length}/${orphans.length} orphan entr(y/ies) adopted`);
  return settleWaiting(stillWaiting, adopted);
}

/**
 * The in-memory half of dating a background-sent message (`reconcileOutboxSent`'s `onDated`): the
 * row takes the server's receive time and its place by it (`replaceMessageOrdered`), and a row still
 * drawn as unsent is drawn sent - the background service delivered it.
 *
 * @returns whether a row changed.
 */
export function dateBackgroundSentRow(
  conversations: {
    entries(): IterableIterator<[string, Conversation]>;
    set(key: string, value: Conversation): unknown;
  },
  messageId: string,
  receivedAt: number
): boolean {
  for (const [key, convo] of conversations.entries()) {
    const idx = convo.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) continue;
    const row = convo.messages[idx];
    if (row.serverTimestamp === receivedAt && row.status !== 'pending') return false;
    const unsent = row.status === 'pending' || row.status === 'sending';
    conversations.set(key, {
      ...convo,
      messages: replaceMessageOrdered(convo.messages, idx, {
        ...row,
        serverTimestamp: receivedAt,
        ...(unsent ? { status: 'sent' as const } : {}),
      }),
    });
    return true;
  }
  return false;
}
