import { isTauriRuntime } from '$lib/utils/openExternal';
import { withDeviceKeyHeld } from '$lib/db/deviceKeyGate';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';

/** Converts a Uint8Array to a lowercase hex string (e.g. `Uint8Array([0xde,0xad])` → `"dead"`). */
export function toHex(buffer: Uint8Array): string {
  return Array.from(buffer)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Null-safe hex conversion - returns '' for null/undefined/empty buffers. */
export function bytesToHex(bytes?: Uint8Array | null): string {
  return bytes && bytes.length > 0 ? toHex(bytes) : '';
}
/** Parses a lowercase or uppercase hex string into a Uint8Array. */
export function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Decodes a standard base64 string back to a Uint8Array.
 *
 * A plain `charCodeAt` loop, NOT `Uint8Array.from(atob(s), cb)`: that form walks the string as an
 * iterable and materialises it first, measured on 18 MB of base64 (Chrome, 2026-10-11) at 1114 ms
 * and +266 MB of heap against 58 ms and +17 MB for this loop. It is what a queued 13 MB attachment
 * paid twice on every read of its outbox row.
 */
export function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Bytes turned into one string per `fromCharCode` call: under the argument-count limit of `apply`. */
const BASE64_CHUNK_BYTES = 0x8000;

/**
 * Encodes a Uint8Array as a standard base64 string.
 *
 * The binary string is built in {@link BASE64_CHUNK_BYTES} slices and joined once, NOT by `+=` one
 * character at a time: that makes one cons-string node per BYTE (13 MB of file = ~260 MB of heap
 * before `btoa` flattens it, 411 ms; the chunked form is 82 ms and flat - Chrome, 2026-10-11).
 */
export function toBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK_BYTES) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + BASE64_CHUNK_BYTES) as never));
  }
  return btoa(parts.join(''));
}

const B64_PREFIX = 'b64:';

// ── IndexedDB storage for MLS state ──────────────────────────────────────────
// IndexedDB has no meaningful size limit (typically GBs), unlike localStorage
// which is capped at ~5 MB. The MLS state blob grows with group count and
// prekey pool size, so we store it as raw binary here.

// Separate DB from the message/conversation DB to avoid version conflicts
const IDB_NAME = `CanariDBMls_`;
const IDB_STORE = 'state';

/** IndexedDB key for PIN-encrypted MLS state (loaded at login). */
export const MLS_STATE_ENCRYPTED_KEY = 'mls_autosave';
/** IndexedDB key for the monotonic write version guarding against stale overwrites. */
export const MLS_STATE_VERSION_KEY = 'mls_autosave_ver';
/** @deprecated Legacy plain autosave key — purged on load; never written anymore. */
const MLS_STATE_PLAIN_KEY_LEGACY = 'mls_autosave_plain';

// Monotonic snapshot versioning (write-if-newer). The live MLS client is epoch-monotonic, so a
// snapshot taken later never reflects a staler state than an earlier one. Tagging each snapshot
// with an increasing version at the synchronous capture moment, and refusing any IDB write whose
// version is not strictly newer than what is stored, prevents a slow off-thread encryption from
// overwriting a fresher concurrent write (which would silently regress the persisted epoch). The
// version travels with the bytes via a WeakMap, so the async Argon2 step cannot reorder it. Only a
// plain integer is persisted at rest - no groupId/epoch - so privacy is unchanged.
let _snapshotSeq = 0;
const _snapshotVersions = new WeakMap<Uint8Array, { seq: number; writer: string }>();

/**
 * WHO WROTE LAST, so a refusal can name BOTH sides of the race it just resolved.
 *
 * A guard that says "v134 lost to v135" states the outcome and hides the question. The campaign
 * carried that line as unexplained dirt on four HEAL-REVOKE rows for two days, and it could not be
 * attributed because nothing recorded which code path either number belonged to. A refusal is only
 * a lead if it names the two paths that overlapped.
 *
 * A module global is the right scope: the version counter is one too, both describe THIS document's
 * writers, and a second tab's writes are a different case the equality branch below already
 * separates.
 */
let _lastAcceptedWriter = '(nothing yet this session)';

/**
 * The version THIS document last wrote, per account - what tells an own later export from another
 * tab's blob when a write is refused as older (2026-10-21).
 *
 * The version counter is per document, so a stored version equal to the one recorded here can only
 * be this document's own blob: another writer reaching the same number is refused as a collision
 * and never stored. And this document's versions are tagged at capture from one monotonic counter,
 * so its later version holds every change its earlier capture held. An untagged write (restore,
 * migration) stores bytes without moving the version, so THIS document's clears the record.
 * ANOTHER document's cannot, and is not seen: its restore leaves this record true-looking, and an
 * older flight here then reads `superseded` over bytes it does not hold - a named residual
 * (docs/wiki/protocols/mls-desync-prevention.md), closed only when every write carries a version.
 */
const _ownStoredVersion = new Map<string, number>();

/**
 * Tags `bytes` with the next monotonic snapshot version and returns the same reference.
 *
 * MUST BE CALLED IN THE SAME SYNCHRONOUS TURN AS THE CAPTURE THAT PRODUCED `bytes`. The number
 * orders CAPTURES, so tagging after an await gives a stale snapshot a fresh number and inverts the
 * ordering it exists to establish - see `propagateMlsSnapshotVersion` for the one legitimate way to
 * carry a version across an async transformation.
 *
 * @param writer which code path captured this - it is what a refusal will name.
 */
export function tagMlsSnapshot(bytes: Uint8Array, writer = 'unnamed'): Uint8Array {
  _snapshotVersions.set(bytes, { seq: ++_snapshotSeq, writer });
  return bytes;
}

/**
 * Copies the snapshot version from `from` to `to`, for bytes DERIVED from an already-tagged capture.
 *
 * THIS IS HOW A VERSION CROSSES AN AWAIT HONESTLY. `to` is a transformation of `from` - re-encrypted,
 * or returned by a worker that was handed `from` - so it describes the state as of `from`'s capture
 * and must carry `from`'s number. Tagging `to` afresh instead dates a stale snapshot to now, which
 * is the inversion the ordering exists to prevent.
 */
export function propagateMlsSnapshotVersion(from: Uint8Array, to: Uint8Array): Uint8Array {
  const v = _snapshotVersions.get(from);
  if (v !== undefined) _snapshotVersions.set(to, v);
  return to;
}

/** Which code path captured `bytes`, or undefined if they were never tagged. */
export function mlsSnapshotWriter(bytes: Uint8Array): string | undefined {
  return _snapshotVersions.get(bytes)?.writer;
}

/** Returns the snapshot version tagged onto `bytes`, or undefined if the bytes were never tagged. */
export function mlsSnapshotVersion(bytes: Uint8Array): number | undefined {
  return _snapshotVersions.get(bytes)?.seq;
}

/**
 * Raises the snapshot counter to at least `version`.
 * The counter resets on page reload while the stored version does not, so a fresh session must
 * seed from the persisted version or its first writes would look stale and be skipped.
 */
export function seedMlsSnapshotSeq(version: number | undefined): void {
  if (version !== undefined && version > _snapshotSeq) _snapshotSeq = version;
}

let _dbPromise: Promise<IDBDatabase> | null = null;

/**
 * Closes this module's cached handle on `CanariDBMls_<userId>`, so a later delete can complete.
 *
 * IT IS THE ONE CONNECTION NO CALLER CAN REACH, AND THAT IS WHY IT SURVIVED EVERY WIPE. `_dbPromise`
 * is a module singleton opened on first use and never released; `removeMlsState` REOPENS it, and it
 * is the last thing a revoked device does before `wipeDeviceToFactory` tries to drop the database.
 * `indexedDB.deleteDatabase` does not fail on an open connection, it BLOCKS - so the wipe logged
 * `CanariDBMls_... is still open elsewhere - delete deferred`, reported two stores SURVIVED, and a
 * device its owner had declared lost kept its MLS store. Measured on prod by HEAL-REVOKE-5,
 * 2026-08-29; every other surface said the wipe had worked.
 *
 * `close()` returns immediately and the connection ends once its open transactions finish, so this
 * is awaited on the handle rather than on the close: what the caller needs is that no NEW
 * transaction can be started, which nulling the cache guarantees.
 */
export async function closeMlsDb(): Promise<void> {
  const pending = _dbPromise;
  _dbPromise = null;
  if (!pending) return;
  // A handle that never opened has nothing to close, and its rejection is not this function's to
  // report - the caller that asked for it already logged one.
  await pending.then((db) => db.close()).catch(() => undefined);
}

function openMlsDb(userId: string): Promise<IDBDatabase> {
  if (!_dbPromise) {
    _dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME + userId, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        _dbPromise = null;
        reject(req.error);
      };
    });
  }
  return _dbPromise;
}

/**
 * Persist the MLS state blob for `userId` in IndexedDB.
 * Stores raw bytes - no base64 overhead.
 */
/**
 * What became of one MLS state write: `written`; `superseded` (not written, because THIS document's
 * own later capture is already stored, which holds everything this one did); or refused by the
 * version guard as `stale` (older than another document's stored blob) or `collision` (another
 * writer reached the same version). A checkpoint is durable on `written` or `superseded`; a write
 * that must land ITSELF - a device key change's re-seal - only on `written`. `ended` is the writing
 * document's own refusal, not the guard's: its {@link MlsStateWriteLatch} is set.
 */
export type MlsStateWriteOutcome = 'written' | 'superseded' | 'stale' | 'collision' | 'ended';

/**
 * A write was refused by the version guard, so the state it carried is NOT on disk. The device key
 * change throws it (a dropped re-seal leaves the stored state under the OLD key), and so does a web
 * checkpoint, whose waiters would otherwise declare that state durable. The guard has already said
 * it in one line; a catcher that only re-reports it adds noise.
 *
 * `ended` is not the guard's: the document itself refused the write, because a rotation it ran was
 * refused and what it holds in memory is on no disk ({@link MlsStateWriteLatch}). That refusal is
 * said once, by the document, the first time it refuses.
 */
export class MlsStateWriteRefusedError extends Error {
  constructor(readonly outcome: Exclude<MlsStateWriteOutcome, 'written'>) {
    super(
      outcome === 'ended'
        ? 'the MLS state write was refused: this document ended after a refused rotation'
        : `the MLS state write was refused by the version guard (${outcome})`
    );
    this.name = 'MlsStateWriteRefusedError';
  }
}

/**
 * A checkpoint that failed where NOTHING can have been stored: the snapshot did not export or seal,
 * or the IndexedDB transaction that carried it failed (a transaction is atomic - one that does not
 * complete stored nothing). Thrown by the web checkpoint, whose store has no other path; a native
 * checkpoint is one call that exports, seals and writes a file, so its failure proves nothing about
 * the file and stays untyped.
 */
export class MlsCheckpointNotWrittenError extends Error {
  constructor(
    readonly step: 'export' | 'store',
    readonly cause: unknown
  ) {
    super(`the MLS checkpoint failed at its ${step} - nothing was stored: ${String(cause)}`);
    this.name = 'MlsCheckpointNotWrittenError';
  }
}

/**
 * Whether a failed checkpoint PROVES the state it carried is not on disk from this write: the guard
 * or the document refused it ({@link MlsStateWriteRefusedError}), or it failed before anything could
 * be stored ({@link MlsCheckpointNotWrittenError}). Anything else is ambiguous.
 */
export function checkpointWroteNothing(e: unknown): boolean {
  return e instanceof MlsStateWriteRefusedError || e instanceof MlsCheckpointNotWrittenError;
}

/**
 * Persists the PIN-encrypted MLS checkpoint. Used at login and on critical flush.
 *
 * THROUGH THE DEVICE-KEY GATE (`db/deviceKeyGate.ts`): a write waits while another tab changes the
 * device key and is refused once this tab's key is retired, so an old leader's checkpoint can never
 * land under the old key after the change re-sealed the state.
 */
export async function saveMlsStateEncrypted(
  userId: string,
  bytes: Uint8Array,
  latch?: MlsStateWriteLatch
): Promise<MlsStateWriteOutcome> {
  return withDeviceKeyHeld(userId, () => writeMlsState(userId, bytes, latch));
}

/**
 * A document's write latch, read and set INSIDE the write's own transaction.
 *
 * A check made before the write starts is not enough: a checkpoint captures, then encrypts off the
 * main thread, then waits for the gate and the database, and the latch can be set by another write
 * of the same document during any of those awaits. IndexedDB serialises read-write transactions on
 * one store, so the verdict below and the put are one synchronous step, and a latch set by an earlier
 * transaction's verdict is seen by every later one.
 */
export interface MlsStateWriteLatch {
  /** True once this document may write no MLS state: the write resolves `ended`, nothing stored. */
  isEnded(): boolean;
  /**
   * For a write whose refusal ENDS the document (a rotation's checkpoint): called synchronously in
   * the transaction that refused it, so no later transaction of this document can land.
   */
  endOnRefusal?(): void;
}

async function writeMlsState(
  userId: string,
  bytes: Uint8Array,
  latch?: MlsStateWriteLatch
): Promise<MlsStateWriteOutcome> {
  if (latch?.isEnded()) return 'ended';
  if (isTauriRuntime()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('save_mls_state', { data: Array.from(bytes) });
      return 'written';
    } catch (e) {
      console.warn('[MLS] save_mls_state failed:', e);
      throw e;
    }
  }

  const version = mlsSnapshotVersion(bytes);
  const db = await openMlsDb(userId);
  return new Promise<MlsStateWriteOutcome>((resolve, reject) => {
    let outcome: MlsStateWriteOutcome = 'written';
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const store = tx.objectStore(IDB_STORE);
    const verReq = store.get(MLS_STATE_VERSION_KEY);
    verReq.onsuccess = () => {
      // THE LATCH, AT THE PUT: see `MlsStateWriteLatch` for why the check at the start is not one.
      if (latch?.isEnded()) {
        outcome = 'ended';
        return;
      }
      const stored = (verReq.result as number | undefined) ?? 0;
      // A tagged write older than or equal to what is stored is a stale flush - skip it so a slow
      // encrypted checkpoint cannot clobber a fresher concurrent write. Untagged writes (restore,
      // migration) have no concurrency and always land.
      //
      // TWO CASES, AND THEY ARE NOT THE SAME EVENT. `_snapshotSeq` is a PER-DOCUMENT counter seeded
      // from the stored version on load, so:
      //
      //   version < stored   a newer capture is on disk: this document's own (split out below as
      //                      `superseded`), or another tab's whose counter ran further.
      //   version === stored two writers seeded from the same stored value both produced this
      //                      number. Within one document that cannot happen (the counter only goes
      //                      up), so it means a SECOND writer - another tab. Nothing is stale; the
      //                      two are simply not comparable, and this write is dropped.
      //
      // One sentence covered both and called both "stale". TAB-4 (two tabs of one client) makes the
      // equality case fire on an ordinary run - measured 2026-09-05, `v3294 <= stored v3294` - so the
      // line was one a reader learns to skip, which is the one that hides the next defect. Whether
      // dropping the second tab's write can lose state is a real question and is P2 in `backlog.md`;
      // it is not answered by the wording, but it is no longer hidden by it.
      // NAMES BOTH PATHS, because a refusal that states only the outcome cannot be acted on. The
      // two writers ARE the finding: this line is the visible end of two captures overlapping, and
      // which two decides whether the overlap is legitimate coalescing or an ordering inversion.
      const mine = mlsSnapshotWriter(bytes) ?? 'unnamed';
      // OLDER THAN STORED SPLITS AGAIN, ON WHO WROTE THE STORED BLOB (2026-10-21). This document's
      // own later export already holds everything this capture held - a direct `persistCheckpoint`
      // landing before a slower persister flight is the ordinary case - so it is `superseded`, and
      // SILENT: nothing is lost and nothing upstream is wrong. Against another tab's blob it is a
      // refusal, and the one line it gets is this one: the callers rethrow it typed and say nothing.
      if (version !== undefined && version < stored) {
        if (_ownStoredVersion.get(userId) === stored) {
          outcome = 'superseded';
          return;
        }
        console.warn(
          `[MLS] MLS state write REFUSED as stale (v${version} < stored v${stored}) - the stored ` +
            `blob is another document's (this one last wrote ` +
            `${_ownStoredVersion.has(userId) ? `v${_ownStoredVersion.get(userId)}` : 'nothing'}), so ` +
            `this state from ${mine} is not on disk`
        );
        outcome = 'stale';
        latch?.endOnRefusal?.();
        return;
      }
      if (version !== undefined && version === stored) {
        console.warn(
          `[MLS] MLS state write REFUSED: snapshot v${version} collides with the stored one - ` +
            `another writer reached this version from the same seed, so the two are not ` +
            `comparable and this state from ${mine} is not on disk`
        );
        outcome = 'collision';
        latch?.endOnRefusal?.();
        return;
      }
      store.put(bytes, MLS_STATE_ENCRYPTED_KEY);
      if (version !== undefined) {
        store.put(version, MLS_STATE_VERSION_KEY);
        _lastAcceptedWriter = mine;
      }
    };
    verReq.onerror = () => reject(verReq.error);
    tx.oncomplete = () => {
      if (outcome === 'written') {
        // Recorded on COMMIT, never on the put: a transaction that fails stored nothing of ours.
        if (version !== undefined) _ownStoredVersion.set(userId, version);
        else _ownStoredVersion.delete(userId);
      }
      resolve(outcome);
    };
    tx.onerror = () => reject(tx.error);
  });
}

/** Removes a legacy plain MLS snapshot if present (pre-option-2 installs). */
export async function purgeLegacyPlainMlsState(userId: string): Promise<void> {
  if (isTauriRuntime()) return;

  const db = await openMlsDb(userId);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(MLS_STATE_PLAIN_KEY_LEGACY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** @deprecated Alias for {@link saveMlsStateEncrypted}. */
export async function saveMlsState(
  userId: string,
  bytes: Uint8Array,
  latch?: MlsStateWriteLatch
): Promise<MlsStateWriteOutcome> {
  return saveMlsStateEncrypted(userId, bytes, latch);
}

/**
 * Load the MLS state blob for `userId` from IndexedDB.
 *
 * Includes a one-time migration: if the key is absent in IDB but present in
 * localStorage (old format), the data is migrated automatically and the
 * localStorage entry is removed.
 */
/**
 * A state of ZERO bytes is an ABSENT state, and this is the only place that decides it.
 *
 * It used to be decided twice. The native branch guarded `res.length > 0`; the IndexedDB branch
 * resolved `req.result ?? null` and then tested the result for truthiness - and an empty
 * `Uint8Array` is truthy. So the same damage answered "nothing stored" on the phone and "a state
 * that exists and is empty" on the web.
 *
 * The asymmetry is not cosmetic, because of what the caller does with the answer: `sessionAuth`
 * passes `noFreshStart: !!bytes`, whose entire purpose is to stop a device that HAS history from
 * silently starting over. An empty state armed that guard against itself - init is handed zero bytes
 * and forbidden to start fresh - so a web device whose state had been written short by an
 * interrupted flush or a full disk could not log in at all, while the phone re-enrolled cleanly.
 *
 * One predicate, at both returns, so the next backend inherits the rule instead of restating it.
 */
const stateOrAbsent = (bytes: Uint8Array | null | undefined): Uint8Array | null =>
  bytes && bytes.length > 0 ? bytes : null;

/**
 * The size of the natively stored MLS state, 0 when there is none - **Tauri only**.
 *
 * WHY A SIZE AND NOT THE BYTES. `mls.bin` is megabytes (7,8 MB measured on a real account) and it
 * crosses the Tauri bridge as a JSON array of per-byte numbers. Asking "is there a state" by
 * loading it cost 908 ms of main thread warm and blocked a cold launch for 2 731 ms, which the
 * fingerprint prompt waited out. One `metadata()` syscall answers the same question.
 *
 * ZERO IS ABSENT, the same rule {@link stateOrAbsent} applies to the bytes and for the same reason:
 * a state written short by an interrupted flush is damage, not history, and must not arm
 * `noFreshStart` against the device it belongs to.
 *
 * Throws nothing: an unreadable answer is reported as 0 by the command, which is the same verdict
 * as a first install - the only safe one, since the alternative is refusing a login on a stat.
 */
export async function mlsStateSize(): Promise<number> {
  if (!isTauriRuntime()) return 0;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return (await invoke<number>('mls_state_size')) ?? 0;
  } catch (e) {
    console.warn('[MLS] mls_state_size failed:', e);
    return 0;
  }
}

/**
 * Whether this device holds a saved MLS state - the BOOLEAN question, on both runtimes.
 *
 * Two call sites only ever tested the result of {@link loadMlsState} for truthiness, and on Tauri
 * that answer cost the whole blob across the bridge ({@link mlsStateSize}). Neither is on the
 * launch path, which is why they are not the reason that command exists - but a megabyte-scale
 * read to decide whether to show a link is the same defect, found twice.
 *
 * On the web the bytes ARE the cheap answer: IndexedDB hands them over in-process, and there is no
 * size-only query for a record. So the split is not a fallback, it is the same question asked the
 * way each store can answer it.
 */
export async function hasMlsState(userId: string): Promise<boolean> {
  if (isTauriRuntime()) return (await mlsStateSize()) > 0;
  return !!(await loadMlsState(userId));
}

export async function loadMlsState(userId: string): Promise<Uint8Array | null> {
  // THROUGH THE GATE: a tab that reloads while another changes the device key reads the state only
  // once it has moved, never the old-key state with the vault's new key.
  return withDeviceKeyHeld(userId, () => readMlsState(userId));
}

async function readMlsState(userId: string): Promise<Uint8Array | null> {
  if (isTauriRuntime()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const res = await invoke<number[] | null>('load_mls_state');
      return res && Array.isArray(res) ? stateOrAbsent(Uint8Array.from(res)) : null;
    } catch (e) {
      console.warn('[MLS] load_mls_state failed:', e);
      return null;
    }
  }

  const db = await openMlsDb(userId);
  const idbResult = await new Promise<Uint8Array | null>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const store = tx.objectStore(IDB_STORE);
    const req = store.get(MLS_STATE_ENCRYPTED_KEY);
    const verReq = store.get(MLS_STATE_VERSION_KEY);
    tx.oncomplete = () => {
      // Seed this session's counter above the persisted version so the first flush is not
      // mistaken for stale (the in-memory counter resets on reload; the stored version does not).
      seedMlsSnapshotSeq(verReq.result as number | undefined);
      resolve((req.result as Uint8Array) ?? null);
    };
    tx.onerror = () => reject(tx.error);
  });
  const stored = stateOrAbsent(idbResult);
  if (stored) {
    void purgeLegacyPlainMlsState(userId).catch(() => {});
    return stored;
  }

  // Migration path: read legacy localStorage entry, move it to IDB, erase from localStorage.
  const saved = localStorage.getItem(ACCOUNT_KEY.legacyMlsAutosave(userId));
  if (!saved) return null;
  const bytes = saved.startsWith(B64_PREFIX)
    ? fromBase64(saved.slice(B64_PREFIX.length))
    : fromHex(saved);
  // Already inside the gate (`loadMlsState`): the ungated write, or it would wait on itself.
  await writeMlsState(userId, bytes);
  localStorage.removeItem(ACCOUNT_KEY.legacyMlsAutosave(userId));
  // The migration path answers the same question, so it takes the same rule: a legacy entry that
  // decoded to nothing is not a state to hand to init either.
  return stateOrAbsent(bytes);
}

/** Remove the MLS state for `userId` from IndexedDB (and legacy localStorage). */
export async function removeMlsState(userId: string): Promise<void> {
  // Remove legacy localStorage entry always
  try {
    localStorage.removeItem(ACCOUNT_KEY.legacyMlsAutosave(userId));
  } catch {
    /* ignore */
  }

  if (isTauriRuntime()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('delete_mls_state');
    } catch (e) {
      console.warn('[MLS] delete_mls_state failed:', e);
    }
    return;
  }

  const db = await openMlsDb(userId);
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(MLS_STATE_ENCRYPTED_KEY);
    tx.objectStore(IDB_STORE).delete(MLS_STATE_PLAIN_KEY_LEGACY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Loads the MLS state and returns it as a hex string for use in backup/export files. Returns `undefined` if no state is stored. */
export async function exportMlsStateAsHex(userId: string): Promise<string | undefined> {
  const bytes = await loadMlsState(userId);
  return bytes ? toHex(bytes) : undefined;
}
