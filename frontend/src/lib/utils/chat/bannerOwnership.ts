/**
 * WHO OWNS THE BANNER OF A MESSAGE THIS PAGE RECEIVED WHILE THE iPHONE APP WAS NOT IN FRONT: the page,
 * or the push the server sent for the same queued row - as the server's ACK answer says.
 *
 * In the background the page still holds its socket for a while, receives a frame and could raise a
 * banner; the server pushes the same row when its ACK has not arrived after ten seconds, and the
 * notification extension raises a banner for that push. Neither could see the other, so a message
 * read on arrival in the background was announced twice, or - with the page silenced - not at all
 * when the ACK beat the push. The server now makes the ACK and the push exclusive and its ACK answer
 * names the rows a push already owns (`apps/chat-delivery-service/src/services/push-claim.ts`):
 *
 * - `push`: the push won; the extension announced it. The page stays silent.
 * - `page`: the ACK won, no push will be sent; the page announces it.
 * - `unresolved`: the server could not say. The page announces it - a duplicate, never a missing
 *   banner.
 * - `legacy`: a server older than the claim answered. Today's behaviour: the page announces it.
 *
 * THE PAGE WAITS FOR THE ANSWER, HOWEVER LONG IT TAKES: an ACK that fails is persisted and retried by
 * the next one (`ackRetry.ts`), and that retry's answer settles the wait. A frame whose ACK never
 * reaches the server stays silent here, and that is right: its row stays queued, so the server
 * pushes it and the extension announces it.
 *
 * Keyed by the QUEUED row id, which is what the server claims; the message pipeline binds each
 * message id it hands the page to the queued row that carried it ({@link bindQueuedRow}).
 */

/** What decides one message's banner, by queued row - see the file comment. */
export type BannerVerdict = 'page' | 'push' | 'unresolved' | 'legacy';

/** How many bindings and verdicts are kept: far above one session's unannounced backlog. */
const KEPT = 2000;

/** message id -> queued row id, for every message the pipeline delivered from a queued row. */
const queuedRowOf = new Map<string, string>();
/** queued row id -> the ACK's verdict, once an answer named it. */
const verdicts = new Map<string, BannerVerdict>();
/** queued row id -> the decisions waiting for its verdict. */
const waiting = new Map<string, Array<(verdict: BannerVerdict) => void>>();
/** A legacy server is said once per session: its consequence does not change per message. */
let legacySaid = false;

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > KEPT) map.delete(map.keys().next().value as string);
}

/** Records that `messageId` reached this page in the queued row `queuedId`. */
export function bindQueuedRow(messageId: string | undefined, queuedId: string | undefined): void {
  if (messageId && queuedId) remember(queuedRowOf, messageId, queuedId);
}

/**
 * Settles every requested id of one ACK with the server's answer - the one place every answer
 * arrives, retries out of sessionStorage included (`ackMessagesWithRetry`).
 *
 * @param answer the response body; `pushed` and `unresolved` absent means a server older than the
 *   claim (docs/wiki/legacy-compatibility.md).
 */
export function settleAckAnswer(requested: readonly string[], answer: unknown): void {
  const body = (answer ?? {}) as { pushed?: unknown; unresolved?: unknown };
  const legacy = !Array.isArray(body.pushed) || !Array.isArray(body.unresolved);
  if (legacy && !legacySaid) {
    legacySaid = true;
    console.warn(
      '[NOTIF] the ACK answer names no banner owner - a server older than the claim; every message is announced by the page as before (said once per session)'
    );
  }
  const pushed = new Set(legacy ? [] : (body.pushed as unknown[]));
  const unresolved = new Set(legacy ? [] : (body.unresolved as unknown[]));
  for (const id of requested) {
    const verdict: BannerVerdict = legacy
      ? 'legacy'
      : pushed.has(id)
        ? 'push'
        : unresolved.has(id)
          ? 'unresolved'
          : 'page';
    remember(verdicts, id, verdict);
    const waiters = waiting.get(id);
    waiting.delete(id);
    for (const resolve of waiters ?? []) resolve(verdict);
  }
}

/**
 * The verdict for each of `messageIds`, once the ACK of its queued row has answered. A message not
 * carried by a queued row cannot have been pushed, so it is the page's at once.
 */
export async function bannerVerdicts(
  messageIds: readonly string[]
): Promise<Map<string, BannerVerdict>> {
  const entries = await Promise.all(
    messageIds.map(async (messageId): Promise<[string, BannerVerdict]> => {
      const queuedId = queuedRowOf.get(messageId);
      if (!queuedId) return [messageId, 'page'];
      const known = verdicts.get(queuedId);
      if (known) return [messageId, known];
      return [
        messageId,
        await new Promise<BannerVerdict>((resolve) => {
          const list = waiting.get(queuedId) ?? [];
          list.push(resolve);
          waiting.set(queuedId, list);
        }),
      ];
    })
  );
  return new Map(entries);
}

/**
 * Drops every binding, verdict and wait - on sign-out, with the persisted ACKs it mirrors
 * (`clearPersistedPendingAcks`). A dropped wait never settles: its decision raises nothing, which
 * is right for an account that is no longer here.
 */
export function forgetBannerOwnership(): void {
  queuedRowOf.clear();
  verdicts.clear();
  waiting.clear();
}
