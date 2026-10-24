import type { EntityManager } from 'typeorm';
import type { Logger } from '@nestjs/common';
import { QueuedMessage } from '../entities/queued-message.entity';
import { QueuedPayload } from '../entities/queued-payload.entity';

/**
 * The environment key of the WRITER's switch: whether a key-group fan-out is stored as one shared
 * payload. A literal row of `infrastructure/deploy/env-manifest.tsv`, `false` on both estates.
 */
export const SHARED_PAYLOAD_WRITES_ENV = 'QUEUED_PAYLOAD_SHARED_WRITES';

/**
 * READS THE WRITER'S SWITCH, ONCE, AT BOOT. The readers ship before the writer.
 *
 * A record written as a shared payload stores NULL in `proto`. An image that predates the readers
 * (the join and {@link materializeDeliveries}) serves that record as an empty frame, and the device
 * ACKs it away: the message is lost, silently. So the readers ship first and the writer stays OFF.
 * The writer is turned on in a LATER release, once every image a rollback could land on reads the
 * join (`docs/wiki/services/chat-delivery.md`). OFF is the per-seat inline write every release has
 * always made.
 *
 * Unset or `false` is OFF and `true` is ON. Anything else THROWS, so the service does not boot: a
 * switch that cannot be read is never read as open, and a typo is not silently read as closed.
 */
export function readSharedPayloadWrites(
  raw: string | undefined,
  logger: Pick<Logger, 'log'>
): boolean {
  const value = raw?.trim() ?? '';
  if (value !== '' && value !== 'true' && value !== 'false') {
    throw new Error(`${SHARED_PAYLOAD_WRITES_ENV} must be "true" or "false", got "${value}"`);
  }
  const on = value === 'true';
  logger.log(
    `[PAYLOAD] ${SHARED_PAYLOAD_WRITES_ENV}=${on} - a key-group fan-out is stored ` +
      (on ? 'as one shared payload' : 'inline, one copy per seat')
  );
  return on;
}

/**
 * The group facts {@link sharesPayload} decides on - the columns `enqueueForLiveGroup` already
 * reads under its row lock, so the decision costs no query.
 */
export interface PayloadGroupFacts {
  distributionWorkspaceId?: string | null;
  distributionChannelId?: string | null;
}

/**
 * WHETHER ONE SEND'S DELIVERY RECORDS SHARE ONE STORED CIPHERTEXT.
 *
 * Only a KEY-DISTRIBUTION group (a community's or a salon's) is in scope, and that is where the
 * bytes are: measured on production 2026-10-21, one payload sat in 31 rows on average and the key
 * groups held 883 MB of a 1.5 GB queue. A DM or a group conversation keeps one row per device with
 * its ciphertext inline, unchanged.
 *
 * And only when there is something to share: a frame queued to ONE device (an addressed Graine
 * answer reaching a single seat) would pay a second row for nothing. The records must also carry
 * the SAME ciphertext - true of every `sendMessage` fan-out by construction, checked here because a
 * shared payload that silently replaced a different one would deliver the wrong frame.
 */
export function sharesPayload(group: PayloadGroupFacts, rows: readonly QueuedMessage[]): boolean {
  if (!(group.distributionWorkspaceId || group.distributionChannelId)) return false;
  if (rows.length < 2) return false;
  const proto = rows[0].proto;
  return !!proto && rows.every((r) => r.proto === proto && !r.isWelcome && !r.ratchetTree);
}

/**
 * Writes ONE payload and points every record at it, inside the caller's transaction.
 *
 * The payload and all its records commit together, which is what makes the collector safe: no
 * committed payload is ever without the records written for it. The records are returned with
 * `proto` put back IN MEMORY, because the caller delivers these very objects in realtime and the
 * envelope is built from the row; only the stored copy is NULL.
 *
 * @param manager the transactional manager the records are saved through
 * @param groupId the group every record names
 * @param rows the delivery records of one send, all carrying the same `proto`
 */
export async function saveWithSharedPayload(
  manager: EntityManager,
  groupId: string,
  rows: QueuedMessage[]
): Promise<QueuedMessage[]> {
  const proto = rows[0].proto as string;
  const payload = await manager
    .getRepository(QueuedPayload)
    .save({ groupId, proto, createdAt: rows[0].createdAt });
  for (const row of rows) {
    row.payloadId = payload.id;
    row.proto = undefined;
  }
  const saved = await manager.getRepository(QueuedMessage).save(rows);
  for (const row of saved) row.proto = proto;
  return saved;
}

/**
 * The join every reader of the queue adds, so a record and its payload are read in ONE statement.
 *
 * One snapshot is the point: reading the payload in a second query would race the collector - a
 * record acknowledged between the two reads lets the hourly pass take its payload, and the reader
 * would then report a missing payload that was never missing.
 */
export const PAYLOAD_RELATION = { payload: true } as const;

/**
 * TURNS STORED DELIVERY RECORDS BACK INTO THE ROWS A DEVICE HAS ALWAYS BEEN HANDED.
 *
 * The rows must have been read WITH their payload joined ({@link PAYLOAD_RELATION}, or
 * `leftJoinAndSelect('q.payload', ...)`). A record pointing at a payload gets that payload's
 * `proto`; a record written inline (every non-key-group row, and every row older than migration
 * 034) is left exactly as it is. `payloadId` and `payload` are then REMOVED from every row: they
 * are storage details, and the pull's JSON must keep the shape every shipped client parses.
 *
 * A record whose payload is missing breaks the invariant the collector rests on - a payload goes
 * only when nothing references it - so it is ACCUSED at error and WITHHELD: never handed over with
 * an empty `proto`, because a device ACKs what it is handed, and an ACK of an empty frame deletes
 * the record that is the only evidence of the loss. Withheld, it stays queued until its retention,
 * and the line names it on every read that meets it.
 *
 * @returns the rows to serve, in their order - every row but the withheld ones, materialised
 */
export function materializeDeliveries(
  rows: QueuedMessage[],
  logger: Pick<Logger, 'error'>,
  traceId: string
): QueuedMessage[] {
  const missing: QueuedMessage[] = [];
  const served: QueuedMessage[] = [];
  for (const row of rows) {
    if (row.payloadId && !row.payload) {
      missing.push(row);
      continue;
    }
    if (row.payload) row.proto = row.payload.proto;
    delete row.payloadId;
    delete row.payload;
    served.push(row);
  }
  if (missing.length > 0) {
    logger.error(
      `[PAYLOAD][${traceId}] MISSING payload for ${missing.length} delivery record(s), WITHHELD - ` +
        `the collector or a purge deleted a referenced payload: ` +
        missing
          .slice(0, 5)
          .map((r) => `${r.id}->${r.payloadId}`)
          .join(',')
    );
  }
  return served;
}

/**
 * DELETES EVERY PAYLOAD NO DELIVERY RECORD REFERENCES - THE ONLY WAY A PAYLOAD IS EVER DELETED,
 * apart from its group ending (`deleteGroupOwnedRows`, which takes the records first).
 *
 * An allowlist decided by durable state, never by a clock: a payload qualifies by having NO record,
 * read in the same statement that deletes it. That is safe against every writer because a payload's
 * reference set only shrinks - all its records are inserted in the transaction that inserts it, and
 * nothing ever adds a record to an existing payload. So whichever record-deleting path ran last
 * (an ACK, a device purge, the 90-day retention, an account erasure), the next pass collects what it
 * left. **A future writer that points a NEW record at an EXISTING payload breaks that proof**, and
 * must take the payload row `FOR SHARE` to restore it.
 *
 * @returns how many payloads were deleted
 */
export async function collectUnreferencedPayloads(manager: EntityManager): Promise<number> {
  const payloadTable = manager.getRepository(QueuedPayload).metadata.tableName;
  const queueTable = manager.getRepository(QueuedMessage).metadata.tableName;
  const result: unknown = await manager.query(
    `DELETE FROM "${payloadTable}" p ` +
      `WHERE NOT EXISTS (SELECT 1 FROM "${queueTable}" q WHERE q."payloadId" = p.id)`
  );
  // The pg driver answers a DELETE through `query` as `[rows, affected]`.
  return Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
}
