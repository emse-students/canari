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
 */
import type { ReadWatermarks } from '$lib/types';
import { appendLog } from '$lib/utils/sessionLog';
import { mergeReadWatermarks, watermarkFor } from './readState';

/** One owed mark: `at` is the read point, `serverAt` the server clock of the newest row it covers. */
export interface OwedSalonMark {
  at: number;
  serverAt?: number;
}

type Owed = Record<string, OwedSalonMark>;

/** What the flush calls to deliver one mark; throws on a refusal. */
export type SendSalonMark = (channelId: string, at: number, serverAt?: number) => Promise<unknown>;

const keyFor = (userId: string): string => `canari.salonReadMarks.${userId.toLowerCase()}`;

function load(userId: string): Owed {
  try {
    const raw = localStorage.getItem(keyFor(userId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Owed) : {};
  } catch (e) {
    appendLog(`[READ] owed salon marks unreadable, treated as none: ${String(e)}`);
    return {};
  }
}

function store(userId: string, owed: Owed): void {
  try {
    if (Object.keys(owed).length === 0) localStorage.removeItem(keyFor(userId));
    else localStorage.setItem(keyFor(userId), JSON.stringify(owed));
  } catch (e) {
    console.warn(
      `[READ] owed salon marks could not be persisted - a reload loses them: ${String(e)}`
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
  if (!(at > 0)) return;
  const owed = load(userId);
  const held = owed[channelId];
  owed[channelId] = {
    at: Math.max(held?.at ?? 0, at),
    ...(Math.max(held?.serverAt ?? 0, serverAt ?? 0) > 0
      ? { serverAt: Math.max(held?.serverAt ?? 0, serverAt ?? 0) }
      : {}),
  };
  store(userId, owed);
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

/** The marks still owed, for tests and diagnostics. */
export function owedSalonReadMarks(userId: string): Owed {
  return load(userId);
}

/**
 * Delivers every owed mark. A mark is removed only when the server answered AND nothing higher was
 * recorded while the call was in flight; a refusal keeps it and is reported once per salon.
 *
 * @returns how many marks the server took.
 */
export async function flushSalonReadMarks(userId: string, send: SendSalonMark): Promise<number> {
  if (!userId) return 0;
  const snapshot = load(userId);
  let delivered = 0;
  for (const [channelId, mark] of Object.entries(snapshot)) {
    try {
      await send(channelId, mark.at, mark.serverAt);
      const current = load(userId);
      if ((current[channelId]?.at ?? 0) <= mark.at) delete current[channelId];
      store(userId, current);
      delivered++;
    } catch (e) {
      console.warn(
        `[READ] salon mark ${mark.at} for ${channelId} not delivered - kept, and asked again at` +
          ` the next load or reconnect (its senders still see it unread until then): ${String(e)}`
      );
    }
  }
  return delivered;
}
