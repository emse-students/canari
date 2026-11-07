import { randomUUID } from 'crypto';
import type { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { isInternalSilent, type EnvelopeContent } from '../services/push-payload';
import { cutDeviceId } from './log-repeat';

/**
 * THE PUSH ENVELOPE - what a `sendPushToUser` push left on this server while its device was sent a
 * content-free wake (migration 046; content-free push WP-W3, docs/wiki/protocols/content-free-push.md
 * section 3.2). Every read and write of `push_envelope` is here.
 *
 * An envelope dies by a proof, never a clock:
 *
 * 1. its device's push registration is deleted - the migration's foreign key, `ON DELETE CASCADE`
 *    (a session end, a revocation, an invalid token, an account erasure);
 * 2. the device registers again ({@link sweepDeviceEnvelopes}) - an app start, and an app that is
 *    open reads the notifications list and the salons over HTTP, which are authoritative;
 * 3. the per-device cap ({@link MAX_ENVELOPES_PER_DEVICE}): already-served envelopes evicted first,
 *    then silent ones, then the oldest visible ones.
 *
 * Serving never deletes ({@link serveEnvelope}): a response lost on the way would otherwise become a
 * `gone` counted as served. The device deduplicates a repeat by the envelope id.
 */

/**
 * The most envelopes one device keeps. Not derived from a platform rate: four times the 50
 * notifications Android lets one app keep active, so a device at the cap holds more banners than it
 * could ever show - it is a device that never fetches, which the `[PUSH_ENVELOPE] cap` line names.
 */
export const MAX_ENVELOPES_PER_DEVICE = 200;

/**
 * The key under which a device's envelopes collapse to the newest, or null. A salon's
 * `channel_read` is superseded by the next read of the same salon - the device dismisses that
 * salon's banners either way - so only the newest is kept. Nothing else collapses.
 *
 * @param data - The push's data map.
 */
export function envelopeCollapseKey(data: Record<string, string>): string | null {
  return data.type === 'channel_read' && data.channelId ? `channel_read:${data.channelId}` : null;
}

/** Why a device asked for was not woken by {@link storeEnvelopes}. */
export type EnvelopeNotWoken =
  /** Its `push_token` row was deleted after the sender read it: there is nobody to wake. */
  | 'registration-gone'
  /** The cap took its new envelope at once (a silent push on a device full of banners). */
  | 'evicted';

/** What {@link storeEnvelopes} did, per device. */
export interface StoredEnvelopes {
  /** The envelope written for each device that is to be woken. */
  ids: Map<string, string>;
  /** Every other device asked for, and why it is not woken. Neither reason is a failure. */
  notWoken: Map<string, EnvelopeNotWoken>;
}

/**
 * Stores ONE push for the given devices of one account, in one transaction: locks the devices'
 * registrations, collapses the older envelopes sharing its key, writes one envelope per device still
 * registered, then enforces the cap per device.
 *
 * THE LOCK COMES FIRST, AND IT IS WHAT MAKES THE REST DETERMINISTIC. `SELECT ... FOR NO KEY UPDATE`
 * on the `push_token` rows, in `deviceId` order:
 * - a registration deleted after the sender read its token is simply not returned (a delete in
 *   flight is waited for, then skipped), so it gets no envelope and fails no foreign key - and the
 *   account's OTHER devices are stored and woken all the same. It is reported `registration-gone`;
 * - two stores to one device are serialised, so the collapse and the cap of the second see the
 *   first's rows: never two read envelopes of one salon, never a device above the cap. The fixed
 *   order means two stores to two shared devices cannot deadlock.
 * `NO KEY UPDATE` (not `UPDATE`) leaves the foreign key's own `KEY SHARE` free, so the inserts below
 * do not wait on themselves, and a concurrent registration upsert waits only for this transaction.
 *
 * Throws only when the transaction itself fails; the caller then wakes none of these devices and
 * accuses it.
 *
 * @param manager - Any manager on the chat-delivery database; the work runs in its own transaction.
 * @param userId - The recipient account.
 * @param deviceIds - The devices to wake, as the sender read their tokens.
 * @param content - What the full push would have carried.
 * @param logger - For the collapse, registration-gone and cap lines.
 * @param traceId - The send's trace id.
 */
export async function storeEnvelopes(
  manager: EntityManager,
  userId: string,
  deviceIds: string[],
  content: EnvelopeContent,
  logger: Logger,
  traceId: string
): Promise<StoredEnvelopes> {
  const silent = isInternalSilent(content.data);
  const collapseKey = envelopeCollapseKey(content.data);
  return manager.transaction(async (tx) => {
    const locked = (await tx.query(
      `SELECT "deviceId" FROM push_token
        WHERE "userId" = $1 AND "deviceId" = ANY($2::varchar[])
        ORDER BY "deviceId"
        FOR NO KEY UPDATE`,
      [userId, deviceIds]
    )) as Array<{ deviceId: string }>;
    const present = locked.map((row) => row.deviceId);
    const notWoken = new Map<string, EnvelopeNotWoken>();
    for (const deviceId of deviceIds) {
      if (present.includes(deviceId)) continue;
      notWoken.set(deviceId, 'registration-gone');
      logger.log(
        `[PUSH_ENVELOPE][${traceId}] registration gone user=${userId} device=${cutDeviceId(deviceId)} - ` +
          `deleted after the send read it; nothing to wake`
      );
    }
    const ids = new Map(present.map((deviceId) => [deviceId, randomUUID()]));
    if (present.length === 0) return { ids, notWoken };
    if (collapseKey) {
      const collapsed = (await tx.query(
        `WITH gone AS (
           DELETE FROM push_envelope
            WHERE "userId" = $1 AND "deviceId" = ANY($2::varchar[]) AND "collapseKey" = $3
           RETURNING id
         )
         SELECT count(*)::int AS n FROM gone`,
        [userId, present, collapseKey]
      )) as Array<{ n: number }>;
      const n = collapsed[0]?.n ?? 0;
      if (n > 0) {
        logger.log(
          `[PUSH_ENVELOPE][${traceId}] collapsed=${n} superseded channel_read envelope(s) of user=${userId}`
        );
      }
    }
    await tx.query(
      `INSERT INTO push_envelope (id, "userId", "deviceId", payload, silent, "collapseKey")
       SELECT u.id, $1, u."deviceId", $2::jsonb, $3, $4
         FROM unnest($5::uuid[], $6::varchar[]) AS u(id, "deviceId")`,
      [userId, JSON.stringify(content), silent, collapseKey, [...ids.values()], [...ids.keys()]]
    );
    for (const deviceId of present) {
      // ALREADY-SERVED envelopes first: the device fetched them, so they are kept only so a lost
      // response can be fetched again - and a live app process, which never re-registers (the client
      // skips an unchanged token), fills its cap with exactly these. Then silent envelopes (a silent
      // push draws nothing, so losing one is worth less than losing any banner - but it is not
      // necessarily superseded: same-salon reads collapse at insert, so what is left is the ONLY read
      // of its salon or another silent kind), then the oldest visible ones.
      const evicted = (await tx.query(
        `WITH gone AS (
           DELETE FROM push_envelope
            WHERE id IN (
              SELECT id FROM push_envelope
               WHERE "userId" = $1 AND "deviceId" = $2
               ORDER BY "servedAt" IS NOT NULL DESC, silent DESC, "createdAt" ASC, id ASC
               LIMIT GREATEST(
                 (SELECT count(*) FROM push_envelope WHERE "userId" = $1 AND "deviceId" = $2) - $3,
                 0
               )
            )
           RETURNING id, silent, "servedAt" IS NOT NULL AS served
         )
         SELECT id, silent, served FROM gone`,
        [userId, deviceId, MAX_ENVELOPES_PER_DEVICE]
      )) as Array<{ id: string; silent: boolean; served: boolean }>;
      if (evicted.length === 0) continue;
      const own = evicted.some((row) => row.id === ids.get(deviceId));
      if (own) {
        ids.delete(deviceId);
        notWoken.set(deviceId, 'evicted');
      }
      reportEviction(logger, traceId, userId, deviceId, evicted, own);
    }
    return { ids, notWoken };
  });
}

/**
 * The cap's line, at the level its evidence earns:
 * - an UNSERVED VISIBLE envelope evicted is a banner the device never fetched - the "device that
 *   never fetches" the WARN names;
 * - an UNSERVED SILENT one is a real loss too, only a smaller one: same-salon reads collapse at
 *   insert, so it is the ONLY pending read of its salon (that salon's badge stays stale until the
 *   app opens) or another silent kind - never merely a superseded read. Logged at log level, so its
 *   rate can be read, and not accused: nothing the user sees is missing;
 * - served envelopes alone are the normal turnover of a live app process: debug.
 */
function reportEviction(
  logger: Logger,
  traceId: string,
  userId: string,
  deviceId: string,
  evicted: Array<{ silent: boolean; served: boolean }>,
  own: boolean
): void {
  const served = evicted.filter((row) => row.served).length;
  const unservedSilent = evicted.filter((row) => !row.served && row.silent).length;
  const unservedVisible = evicted.length - served - unservedSilent;
  const counts =
    `user=${userId} device=${cutDeviceId(deviceId)} max=${MAX_ENVELOPES_PER_DEVICE} ` +
    `served=${served} unserved-silent=${unservedSilent} unserved-visible=${unservedVisible}` +
    (own ? ' including this push - not woken' : '');
  if (unservedVisible > 0) {
    logger.warn(`[PUSH_ENVELOPE][${traceId}] cap ${counts} - a device that never fetches`);
  } else if (unservedSilent > 0) {
    logger.log(`[PUSH_ENVELOPE][${traceId}] cap silent ${counts} - a pending silent push lost`);
  } else {
    logger.debug(`[PUSH_ENVELOPE][${traceId}] cap turnover ${counts}`);
  }
}

/**
 * Deletes every envelope of one device - called by its registration, which happens once per app
 * process: the app is open, and what the envelopes held is on screen over HTTP. Returns how many.
 *
 * @param manager - Any manager on the chat-delivery database.
 * @param userId - The registering account.
 * @param deviceId - The registering device.
 */
export async function sweepDeviceEnvelopes(
  manager: EntityManager,
  userId: string,
  deviceId: string
): Promise<number> {
  const rows = (await manager.query(
    `WITH gone AS (
       DELETE FROM push_envelope WHERE "userId" = $1 AND "deviceId" = $2 RETURNING id
     )
     SELECT count(*)::int AS n FROM gone`,
    [userId, deviceId]
  )) as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

/**
 * Deletes every push registration of an account (its erasure), their envelopes going with them by
 * the cascade. Answers the number of registrations deleted.
 *
 * LOCKS THE ROWS IN `deviceId` ORDER FIRST, the order {@link storeEnvelopes} takes them in. A bare
 * `DELETE ... WHERE "userId" = $1` locks rows in the order its scan meets them; against a store
 * holding device `a` and waiting for `b`, a delete that took `b` first and waits for `a` is a
 * deadlock, and Postgres aborts one of the two. Taking both orders from one rule removes the cycle
 * instead of surviving it.
 */
export async function deleteAccountPushTokens(
  manager: EntityManager,
  userId: string
): Promise<number> {
  return manager.transaction(async (tx) => {
    await tx.query(`SELECT 1 FROM push_token WHERE "userId" = $1 ORDER BY "deviceId" FOR UPDATE`, [
      userId,
    ]);
    const rows = (await tx.query(
      `WITH gone AS (DELETE FROM push_token WHERE "userId" = $1 RETURNING 1)
       SELECT count(*)::int AS n FROM gone`,
      [userId]
    )) as Array<{ n: number }>;
    return rows[0]?.n ?? 0;
  });
}

/**
 * What a fetch of one envelope found.
 *
 * - `served`: the device's own envelope; `times` is how often it has now been served (above one, a
 *   response the device did not keep), `platform` and `locale` its registration's, which decide the
 *   answer's shape.
 * - `foreign`: the id exists under ANOTHER device or account - a wake that arrived for an account the
 *   device no longer runs (content-free-push section 7). The device is answered `gone` all the same:
 *   it must not learn that another account's rows exist.
 * - `gone`: no such envelope - its device registered (the app opened), its registration went, or the
 *   cap evicted it.
 */
export type EnvelopeLookup =
  | {
      kind: 'served';
      content: EnvelopeContent;
      times: number;
      platform: 'android' | 'ios';
      locale: string | null;
    }
  | { kind: 'foreign' }
  | { kind: 'gone' };

/**
 * Serves one envelope to the device that owns it: stamps `servedAt`, counts, and returns its content
 * with the registration's platform and locale - one statement, so the envelope and the registration
 * are read together. NEVER deletes.
 *
 * @param manager - Any manager on the chat-delivery database.
 * @param envelopeId - The wake's `envelopeId`, already checked to be a uuid.
 * @param userId - The fetching account (proven by its PushSecret).
 * @param deviceId - The fetching device.
 */
export async function serveEnvelope(
  manager: EntityManager,
  envelopeId: string,
  userId: string,
  deviceId: string
): Promise<EnvelopeLookup> {
  const rows = (await manager.query(
    `WITH served AS (
       UPDATE push_envelope e
          SET "servedAt" = now(), "servedCount" = e."servedCount" + 1
         FROM push_token t
        WHERE e.id = $1 AND e."userId" = $2 AND e."deviceId" = $3
          AND t."userId" = e."userId" AND t."deviceId" = e."deviceId"
       RETURNING e.payload, e."servedCount", t.platform, t.locale
     )
     SELECT payload, "servedCount", platform, locale FROM served`,
    [envelopeId, userId, deviceId]
  )) as Array<{
    payload: EnvelopeContent;
    servedCount: number;
    platform: string;
    locale: string | null;
  }>;
  const row = rows[0];
  if (row) {
    return {
      kind: 'served',
      content: row.payload,
      times: row.servedCount,
      platform: row.platform === 'ios' ? 'ios' : 'android',
      locale: row.locale,
    };
  }
  const other = (await manager.query(`SELECT 1 FROM push_envelope WHERE id = $1`, [
    envelopeId,
  ])) as unknown[];
  return other.length > 0 ? { kind: 'foreign' } : { kind: 'gone' };
}
