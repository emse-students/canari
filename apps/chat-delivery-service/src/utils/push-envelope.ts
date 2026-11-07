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
 * 3. the per-device cap ({@link MAX_ENVELOPES_PER_DEVICE}), silent envelopes evicted first.
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

/**
 * Stores ONE push for the given devices of one account, in one transaction: collapses the older
 * envelopes sharing its key, writes one envelope per device, then enforces the cap per device.
 *
 * Returns the envelope id written for each device that still holds one - a device whose new envelope
 * the cap evicted at once (a silent push on a device full of envelopes) is absent, and must not be
 * woken for it. Throws when the transaction fails (a registration deleted concurrently fails its
 * foreign key, for one): the caller sends none of these devices a wake and accuses it.
 *
 * @param manager - Any manager on the chat-delivery database; the work runs in its own transaction.
 * @param userId - The recipient account.
 * @param deviceIds - The devices to wake, each with a `push_token` row.
 * @param content - What the full push would have carried.
 * @param logger - For the collapse and cap lines.
 * @param traceId - The send's trace id.
 */
export async function storeEnvelopes(
  manager: EntityManager,
  userId: string,
  deviceIds: string[],
  content: EnvelopeContent,
  logger: Logger,
  traceId: string
): Promise<Map<string, string>> {
  const silent = isInternalSilent(content.data);
  const collapseKey = envelopeCollapseKey(content.data);
  const ids = new Map(deviceIds.map((deviceId) => [deviceId, randomUUID()]));
  return manager.transaction(async (tx) => {
    if (collapseKey) {
      const collapsed = (await tx.query(
        `WITH gone AS (
           DELETE FROM push_envelope
            WHERE "userId" = $1 AND "deviceId" = ANY($2::varchar[]) AND "collapseKey" = $3
           RETURNING id
         )
         SELECT count(*)::int AS n FROM gone`,
        [userId, deviceIds, collapseKey]
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
    for (const deviceId of deviceIds) {
      // Silent envelopes first (oldest first), then the oldest visible ones: a superseded read
      // frame is worth less than any banner.
      const evicted = (await tx.query(
        `WITH gone AS (
           DELETE FROM push_envelope
            WHERE id IN (
              SELECT id FROM push_envelope
               WHERE "userId" = $1 AND "deviceId" = $2
               ORDER BY silent DESC, "createdAt" ASC, id ASC
               LIMIT GREATEST(
                 (SELECT count(*) FROM push_envelope WHERE "userId" = $1 AND "deviceId" = $2) - $3,
                 0
               )
            )
           RETURNING id
         )
         SELECT id FROM gone`,
        [userId, deviceId, MAX_ENVELOPES_PER_DEVICE]
      )) as Array<{ id: string }>;
      if (evicted.length === 0) continue;
      const own = evicted.some((row) => row.id === ids.get(deviceId));
      if (own) ids.delete(deviceId);
      logger.warn(
        `[PUSH_ENVELOPE][${traceId}] cap user=${userId} device=${cutDeviceId(deviceId)} evicted=${evicted.length} ` +
          `max=${MAX_ENVELOPES_PER_DEVICE}${own ? ' including this push - not woken' : ''} - a device that never fetches`
      );
    }
    return ids;
  });
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
