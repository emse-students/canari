/**
 * The salon read marks this device owes the server, kept until the server has taken them.
 *
 * WHY IT EXISTS. A salon's read state lives ONLY on the server (a salon is not stored on the
 * device), and the unread badge after a reload is the server's own count against that mark. The mark
 * used to be a debounced `POST /read-mark` whose failure was one `console.warn` and whose pending
 * value was zeroed BEFORE the call - and was also dropped when the reader left the salon inside the
 * debounce window. So a 500 during a deploy, a dead connection, a reload or a quick back-navigation
 * lost the mark for good, and the next load counted the same messages unread (reported 2026-10-09).
 *
 * So the mark is written here, synchronously, the instant it is decided - before any network - and
 * only removed once the server answered. It is flushed again at the next occasion that proves the
 * server is reachable (communities loaded, live stream back), never on a timer.
 *
 * The merge is `max` per salon, so a replay or an out-of-order write never moves a mark backwards.
 *
 * A DM OR GROUP MARK OWES THE SAME THING, TO THE OUTBOX RATHER THAN THE SERVER (2026-10-17). Its
 * receipt is an MLS `read_watermark` queued after a 2 s debounce, so a process killed inside that
 * window lost it: the local mark had already moved, nothing moved it again, and the peer kept the
 * conversation unread for good. It is now written here when decided, in its own key, and removed only
 * once the outbox has TAKEN the frame - the outbox is durable from there. The owed DM marks are
 * drained into the outbox whenever a controller is registered (`drainOwedDmReadMarks`).
 */
import type { ReadWatermarks } from '$lib/types';
import { appendLog } from '$lib/utils/sessionLog';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import { mergeReadWatermarks, watermarkFor } from './readState';

/** One owed mark: `at` is the read point, `serverAt` the server clock of the newest row it covers. */
export interface OwedSalonMark {
  at: number;
  serverAt?: number;
}

type Owed = Record<string, OwedSalonMark>;

/**
 * THE SERVER ANSWERED THAT THE MARK'S TARGET NO LONGER EXISTS (a salon deleted while a mark was
 * owed: `404 CHANNEL_NOT_FOUND`). Thrown by the deliverer, classified there from the status and the
 * server's code, never from a message. It is an ANSWER, not a failure: the same mark would meet the
 * same answer at every load, so the flush drops it instead of keeping it owed.
 */
export class ReadMarkTargetGoneError extends Error {
  constructor(readonly targetId: string) {
    super(`read mark target ${targetId} no longer exists`);
    this.name = 'ReadMarkTargetGoneError';
  }
}

/**
 * What the flush calls to deliver one mark; throws on a refusal, and {@link ReadMarkTargetGoneError}
 * when the server answered that the target is gone.
 */
export type SendSalonMark = (channelId: string, at: number, serverAt?: number) => Promise<unknown>;

/** Which ledger a mark is owed in: a salon's goes to the server, a DM's or group's to the outbox. */
type MarkSpace = 'salon' | 'dm';

const keyFor = (space: MarkSpace, userId: string): string =>
  space === 'salon' ? ACCOUNT_KEY.salonReadMarks(userId) : ACCOUNT_KEY.dmReadMarks(userId);

function load(space: MarkSpace, userId: string): Owed {
  try {
    const raw = localStorage.getItem(keyFor(space, userId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Owed) : {};
  } catch (e) {
    appendLog(`[READ] owed ${space} marks unreadable, treated as none: ${String(e)}`);
    return {};
  }
}

function store(space: MarkSpace, userId: string, owed: Owed): void {
  try {
    if (Object.keys(owed).length === 0) localStorage.removeItem(keyFor(space, userId));
    else localStorage.setItem(keyFor(space, userId), JSON.stringify(owed));
  } catch (e) {
    console.warn(
      `[READ] owed ${space} marks could not be persisted - a reload loses them: ${String(e)}`
    );
  }
}

/** Records that `userId` has read `channelId` up to `at`, durably, keeping the highest. */
export function recordSalonReadMark(
  userId: string,
  channelId: string,
  at: number,
  serverAt?: number
): void {
  record('salon', userId, channelId, at, serverAt);
}

/** Records that `userId` has read the DM or group `conversationId` up to `at`, durably. */
export function recordDmReadMark(userId: string, conversationId: string, at: number): void {
  record('dm', userId, conversationId, at);
}

function record(space: MarkSpace, userId: string, id: string, at: number, serverAt?: number): void {
  if (!(at > 0)) return;
  const owed = load(space, userId);
  const held = owed[id];
  owed[id] = {
    at: Math.max(held?.at ?? 0, at),
    ...(Math.max(held?.serverAt ?? 0, serverAt ?? 0) > 0
      ? { serverAt: Math.max(held?.serverAt ?? 0, serverAt ?? 0) }
      : {}),
  };
  store(space, userId, owed);
}

/**
 * The read marks a salon holds once the server has answered a load: everyone's, with the READER'S
 * OWN taken from the server and from what this device still owes it - never from what the device
 * believed before.
 *
 * WHY. The receipt effect posts a mark only when reading moves the reader's own watermark, and that
 * watermark used to be restored from the device's conversation row and then merged with the
 * server's as `max`. A mark the device had advanced locally but never delivered (a POST lost before
 * the owed queue existed, a reload inside the debounce) therefore stayed AHEAD of the server's for
 * ever: opening the salon moved nothing, so nothing was posted, and every reload counted the same
 * messages unread on the server's mark (reported 2026-10-09, `#infos`: zero `POST /read-mark`
 * across a whole afternoon). The only local belief allowed above the server's is one that is OWED,
 * because the queue is what delivers it.
 *
 * @param serverMarks the server's marks, already parsed; `undefined` when they could not be loaded,
 *                    in which case nothing can be corrected and `current` is kept.
 * @param owedAt the mark this device still owes for the salon, from {@link owedSalonReadMarks}.
 */
export function salonMarksAfterLoad(
  current: ReadWatermarks | undefined,
  serverMarks: ReadWatermarks | undefined,
  userId: string,
  owedAt: number | undefined,
  salonId: string
): ReadWatermarks | undefined {
  if (!serverMarks) return current;
  const me = userId.toLowerCase();
  const believed = watermarkFor(current, me);
  const own = Math.max(watermarkFor(serverMarks, me), owedAt ?? 0);
  const others = Object.fromEntries(
    Object.entries(mergeReadWatermarks(current, serverMarks) ?? current ?? {}).filter(
      ([userNorm]) => userNorm !== me
    )
  ) as ReadWatermarks;
  if (believed > own) {
    appendLog(
      `[READ] ${salonId.slice(0, 16)}: own mark ${believed} held here is ahead of the server's` +
        ` ${watermarkFor(serverMarks, me)} and owed ${owedAt ?? 0} - the server's is kept, so` +
        ' reading the salon posts the mark again'
    );
  }
  const next: ReadWatermarks = own > 0 ? { ...others, [me]: own } : others;
  return Object.keys(next).length > 0 ? next : undefined;
}

let salonMarksDelivered = 0;

/**
 * A monotonic count of salon marks the server has taken, ticking the instant each one is taken
 * (not when its flush ends). A request sent before a tick may predate the mark it counts, which is
 * how `unread-counts` decides whether it may be shared.
 */
export function salonMarksDeliveredCount(): number {
  return salonMarksDelivered;
}

/** The marks still owed, for tests and diagnostics. */
export function owedSalonReadMarks(userId: string): Owed {
  return load('salon', userId);
}

/**
 * Drops the owed DM mark of a conversation that left this device's store (deleted, or left): its
 * group is gone, so a frame queued for it could only loop in the flusher.
 */
export function forgetDmReadMark(userId: string, conversationId: string): void {
  forget('dm', userId, conversationId);
}

/**
 * Drops the owed mark of a salon this device was told is deleted (`channel.deleted`): posting it
 * could only meet the server's 404. The flush drops it on that 404 too, for a deletion this device
 * was offline for - this is the same answer, known earlier.
 */
export function forgetSalonReadMark(userId: string, channelConversationId: string): void {
  forget('salon', userId, channelConversationId);
}

function forget(space: MarkSpace, userId: string, id: string): void {
  if (!userId) return;
  const owed = load(space, userId);
  if (!(id in owed)) return;
  delete owed[id];
  store(space, userId, owed);
}

/** The DM and group marks still owed to the outbox, for tests and diagnostics. */
export function owedDmReadMarks(userId: string): Owed {
  return load('dm', userId);
}

/**
 * Delivers every owed mark. A mark is removed only when the server answered AND nothing higher was
 * recorded while the call was in flight, or when the server answered that the salon no longer exists
 * ({@link ReadMarkTargetGoneError}); any other refusal or transport failure keeps it, reported once
 * per salon.
 *
 * @returns how many marks the server took.
 */
export function flushSalonReadMarks(userId: string, send: SendSalonMark): Promise<number> {
  return flush('salon', userId, send, 'the next load or reconnect');
}

/**
 * Hands every owed DM or group mark to the outbox; `queue` resolves once the outbox has taken the
 * frame and throws when it could not. Same removal rule as the salon's.
 */
export function flushDmReadMarks(
  userId: string,
  queue: (conversationId: string, at: number) => Promise<unknown>
): Promise<number> {
  return flush('dm', userId, queue, 'the next outbox registration or read');
}

async function flush(
  space: MarkSpace,
  userId: string,
  send: SendSalonMark,
  nextChance: string
): Promise<number> {
  if (!userId) return 0;
  const snapshot = load(space, userId);
  let delivered = 0;
  for (const [id, mark] of Object.entries(snapshot)) {
    try {
      await send(id, mark.at, mark.serverAt);
      const current = load(space, userId);
      if ((current[id]?.at ?? 0) <= mark.at) delete current[id];
      store(space, userId, current);
      delivered++;
      if (space === 'salon') salonMarksDelivered++;
    } catch (e) {
      if (e instanceof ReadMarkTargetGoneError) {
        // AN ANSWER, NOT A FAILURE: dropped, and said once - the mark is gone from storage, so no
        // later flush meets it again. Until 2026-10-29 it was kept and posted at every load, a 404
        // per load for a salon deleted while the mark was owed.
        forget(space, userId, id);
        console.info(
          `[READ] ${space} mark ${mark.at} for ${id} dropped - the server answered that it no longer exists`
        );
        continue;
      }
      console.warn(
        `[READ] ${space} mark ${mark.at} for ${id} not delivered - kept, and asked again at` +
          ` ${nextChance} (its senders still see it unread until then): ${String(e)}`
      );
    }
  }
  return delivered;
}
