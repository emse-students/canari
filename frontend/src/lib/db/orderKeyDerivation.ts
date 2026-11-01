/**
 * Deriving the order key of the message rows that carry only a PROVISIONAL one, shared by both
 * storage backends (`SqliteStorage`, `IndexedDbStorage`).
 *
 * WHY A ROW IS PROVISIONAL. The order key (`storedOrderAt`) is the server's receive time, which is
 * INSIDE the ciphertext. A row written before the key existed (the SQLite v16 step, the IndexedDB
 * v12 upgrade) or imported from a backup (`importEncryptedRow`, whose input is ciphertext) cannot be
 * keyed without the device key, so it is written with its `timestamp` (`sentAt`, readable in the
 * clear) as the key and a PENDING flag. A page read never waits for the real key: it walks the index
 * as it stands - the keyed rows and the provisional ones together - and starts this derivation behind
 * it. The page drawn meanwhile is in the right order on screen anyway, because the timeline sorts on
 * the decrypted `messageTime`; only the store's page BOUNDARY is provisional, and `PageKey.provisional`
 * says so to the one reader that pages below it (`loadOlderMessages`).
 *
 * BOUNDED AND RESUMABLE. The rows are read {@link ORDER_KEY_CHUNK_ROWS} at a time, in primary-key
 * order after the last one read, and each chunk is WRITTEN before the next is read: a kill loses at
 * most one chunk of work, and the next run reads only the rows still pending - the flag is the
 * durable progress, no counter or clock is. One run per conversation at a time
 * ({@link OrderKeyDerivations}).
 *
 * TWO FAILURES, TWO ANSWERS, told apart by TYPE at the throw (`PayloadUnreadableError`), never by a
 * message. A row this key can never read is keyed on its `timestamp` and its flag cleared - it is in
 * no page (the page read skips it), and left pending it would be decrypted again by every run. Any
 * other failure may pass (the key could not be imported, the engine threw), so the row stays pending,
 * the run moves past it, and the next run tries it again.
 */

import { decryptData, PayloadUnreadableError } from '$lib/encryption';
import { appendLog } from '$lib/utils/sessionLog';
import { fromMessagePayload, storedOrderAt } from './messagePayload';

/** Rows read, decrypted and written per step of a derivation. */
export const ORDER_KEY_CHUNK_ROWS = 500;

/** One provisional row as a backend reads it: the clear columns and the sealed payload. */
export interface PendingOrderRow {
  id: string;
  /** `sentAt`, already a number: the key the row is provisionally paged on. */
  timestamp: number;
  iv: Uint8Array;
  cipherText: Uint8Array;
}

/** The row's derived key, to be written only while the row is still pending. */
export interface DerivedOrderKey {
  id: string;
  orderAt: number;
}

/** What one derivation run did, counted for its log line and for the tests. */
export interface OrderKeyDerivation {
  /** Rows keyed on the server time read out of their payload (or their `sentAt` when it has none). */
  derived: number;
  /** Rows this key can never read, keyed on their `sentAt` for good. */
  unreadable: number;
  /** Rows a failure that may pass left pending, for the next run. */
  deferred: number;
}

/** The two storage operations a derivation needs, implemented by each backend. */
export interface OrderKeyIo {
  /** Up to `limit` pending rows of the conversation, by primary key, strictly after `after`. */
  readChunk(after: string | undefined, limit: number): Promise<PendingOrderRow[]>;
  /** Writes the keys and clears the pending flag, touching only rows STILL pending. */
  writeChunk(keyed: readonly DerivedOrderKey[]): Promise<void>;
}

/**
 * Runs one derivation of `conversationId` to the end of its pending rows, chunk by chunk.
 * Rejects only when the store itself fails (a read or a write) - the chunks written before stand.
 */
export async function deriveOrderKeysInChunks(
  conversationId: string,
  deviceKeyB64: string,
  io: OrderKeyIo
): Promise<OrderKeyDerivation> {
  const tag = conversationId.slice(0, 8);
  const done: OrderKeyDerivation = { derived: 0, unreadable: 0, deferred: 0 };
  let after: string | undefined;
  for (;;) {
    const rows = await io.readChunk(after, ORDER_KEY_CHUNK_ROWS);
    if (rows.length === 0) break;
    const keyed: DerivedOrderKey[] = [];
    for (const row of rows) {
      try {
        const payload = (await decryptData(row.cipherText, row.iv, deviceKeyB64)) as Record<
          string,
          unknown
        >;
        const msg = fromMessagePayload(
          { id: row.id, conversationId, timestamp: row.timestamp },
          payload
        );
        keyed.push({ id: row.id, orderAt: storedOrderAt(msg) });
        done.derived++;
      } catch (e) {
        if (e instanceof PayloadUnreadableError) {
          keyed.push({ id: row.id, orderAt: row.timestamp });
          done.unreadable++;
        } else {
          done.deferred++;
          console.warn(
            `[STORE] order key of ${row.id} in ${tag} deferred - the payload could not be read for now: ${String(e)}`
          );
        }
      }
    }
    if (keyed.length > 0) await io.writeChunk(keyed);
    after = rows[rows.length - 1].id;
    if (rows.length < ORDER_KEY_CHUNK_ROWS) break;
  }
  if (done.derived + done.unreadable + done.deferred > 0) {
    appendLog(
      `[STORE] order keys of ${tag}: ${done.derived} derived` +
        (done.unreadable > 0 ? `, ${done.unreadable} unreadable (keyed on their sentAt)` : '') +
        (done.deferred > 0 ? `, ${done.deferred} deferred to the next run` : '')
    );
  }
  return done;
}

/**
 * ONE derivation in flight per conversation, and ONE LANE for all of them: a run starts only when
 * the previous one - whatever its conversation - has settled, so a first boot opening many
 * conversations decrypts one chunk at a time instead of competing with the writes the boot itself
 * makes (review of #2824, E). A second page read of a conversation joins its run instead of
 * decrypting the same rows twice. The entry is dropped when the run settles, so the next read that
 * still finds a pending row (a backup imported since) starts a new run.
 *
 * A RUN THAT DEFERRED A ROW ENDS THE WAITING for its conversation, this session: the row stays
 * flagged for the next session's run, and until then the conversation's pages are read as keyed
 * ({@link gaveUp}) - a load-older does not wait for, and re-read behind, a derivation that would
 * defer the same row again. `rearm` takes it back when new rows arrive to be keyed.
 */
export class OrderKeyDerivations {
  private readonly inFlight = new Map<string, Promise<OrderKeyDerivation>>();
  /** The tail of the one lane every run is queued on. Never rejects. */
  private lane: Promise<unknown> = Promise.resolve();
  /** The conversations whose last run deferred a row, this session. */
  private readonly deferred = new Set<string>();

  /** The run in flight for `conversationId`, or a new one queued on the lane with `start`. */
  run(
    conversationId: string,
    start: () => Promise<OrderKeyDerivation>
  ): Promise<OrderKeyDerivation> {
    const running = this.inFlight.get(conversationId);
    if (running) return running;
    const run = this.lane
      .then(start)
      .then((done) => {
        if (done.deferred > 0) {
          this.deferred.add(conversationId);
          console.warn(
            `[STORE] order keys of ${conversationId.slice(0, 8)}: ${done.deferred} row(s) deferred - its pages are read as keyed until the next session retries them`
          );
        }
        return done;
      })
      .finally(() => {
        if (this.inFlight.get(conversationId) === run) this.inFlight.delete(conversationId);
      });
    this.lane = run.catch(() => undefined);
    this.inFlight.set(conversationId, run);
    return run;
  }

  /** Whether the last run of `conversationId` this session deferred a row - see the class doc. */
  gaveUp(conversationId: string): boolean {
    return this.deferred.has(conversationId);
  }

  /** New rows to key in `conversationId` (a backup import): its next page read derives again. */
  rearm(conversationId: string): void {
    this.deferred.delete(conversationId);
  }

  /**
   * Starts (or joins) a run in the BACKGROUND: the caller does not wait, and a store failure is
   * logged here - the pending rows stay pending and the next page read starts a new run.
   */
  startInBackground(conversationId: string, start: () => Promise<OrderKeyDerivation>): void {
    this.run(conversationId, start).catch((e) => {
      console.error(
        `[STORE] order-key derivation of ${conversationId.slice(0, 8)} stopped - the rows still pending are taken up by the next page read: ${String(e)}`
      );
    });
  }
}
