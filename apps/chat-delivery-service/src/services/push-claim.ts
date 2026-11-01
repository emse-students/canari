/**
 * WHO OWNS THE BANNER OF ONE QUEUED FRAME: the push, or the page that acknowledged it.
 *
 * A frame queued for a phone can be announced twice by construction. The page receives it over the
 * socket and may raise a banner; the server pushes the same row when it is not acknowledged within
 * ten seconds (`scheduleDeferredPush`), or at once to an offline device, and the iOS notification
 * extension raises one too. Neither party could see the other: the page cannot know whether the
 * push already fired, and the push cannot know what the page decided.
 *
 * SO THE TWO ARE MUTUALLY EXCLUSIVE HERE, AND THE ANSWER IS RECORDED. One Redis key per queued row,
 * `push-claim:<queuedId>`, written with `SET ... NX GET`: the first of the ACK and the push to reach
 * it writes its own name, and every later attempt - the other side, or a retry of either - reads
 * back the name that won. A retried ACK therefore hears the same verdict its first attempt was
 * given, and a push that lost does not send. Nothing ever un-claims: a push that claimed and then
 * failed to send still owns the banner, and says so where it failed.
 *
 * Asked only for a frame that would DRAW something: a silent push owns no banner, so it claims
 * nothing (docs/wiki/frontend/mobile.md, "who owns the banner").
 */
import type Redis from 'ioredis';
import { RETENTION_WINDOW_MS } from '../retention.constants';

/** The two parties that can own a frame's banner. */
export type BannerOwner = 'ack' | 'push';

/** The key one queued row's claim is stored under. */
export function pushClaimKey(queuedId: string): string {
  return `push-claim:${queuedId}`;
}

/**
 * How long a claim is kept: GARBAGE COLLECTION, and it must never be what decides a verdict.
 *
 * Two numbers bound when a claim can still be read:
 * - the QUEUE RETENTION, {@link RETENTION_WINDOW_MS} = 90 days. A push claims while its row is
 *   queued, and an ACK claims only for a row it finds queued (`acknowledgeMessages`), so every
 *   claim is written within 90 days of its row's creation.
 * - the longest a PERSISTED ACK can be retried. The client keeps a failed ACK in sessionStorage and
 *   retries it on its next ACK or connection (`ackRetry.ts`): that is bounded by the life of the
 *   page that holds it, not by a clock. A page kept alive past this TTL can therefore retry an ACK
 *   whose claim is gone - and it is then answered `unresolved`, never a guessed verdict, because a
 *   row no longer queued is never claimed afresh. `unresolved` raises the banner (a duplicate, never
 *   a missing one), the same rule as every other unknown on that path.
 *
 * 180 days: twice the retention, so a claim outlives its row by at least 90 days.
 */
export const PUSH_CLAIM_TTL_S = (2 * RETENTION_WINDOW_MS) / 1000;

/**
 * Claims the banner of `queuedId` for `who`, and returns WHO OWNS IT - `who` if this call won, the
 * stored owner otherwise. One atomic `SET NX GET` (Redis >= 7), so there is no window between the
 * attempt and the read. Throws whatever Redis throws: the caller decides what an unknown owner costs.
 */
export async function claimBanner(
  redis: Redis,
  queuedId: string,
  who: BannerOwner
): Promise<BannerOwner> {
  const previous = (await redis.call(
    'SET',
    pushClaimKey(queuedId),
    who,
    'EX',
    String(PUSH_CLAIM_TTL_S),
    'NX',
    'GET'
  )) as string | null;
  if (previous === null) return who;
  if (previous === 'ack' || previous === 'push') return previous;
  // A key under this prefix holds one of two words, and nothing else writes it. Anything else is a
  // writer this file does not know about - refused as unknown rather than read as either owner.
  throw new Error(`push-claim:${queuedId} holds "${previous}", which is neither "ack" nor "push"`);
}

/**
 * Reads the owner recorded for each of `queuedIds`, without claiming: what a retried ACK is told
 * about a row it no longer finds queued. An id with no claim is absent from the map.
 */
export async function readBannerOwners(
  redis: Redis,
  queuedIds: readonly string[]
): Promise<Map<string, BannerOwner>> {
  const owners = new Map<string, BannerOwner>();
  if (queuedIds.length === 0) return owners;
  const values = await redis.mget(...queuedIds.map(pushClaimKey));
  queuedIds.forEach((id, i) => {
    const value = values[i];
    if (value === 'ack' || value === 'push') owners.set(id, value);
  });
  return owners;
}
