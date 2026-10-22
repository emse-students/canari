/**
 * backup.ts - Canari message backup / restore (WhatsApp-style)
 *
 * Export flow:
 *   1. Read all conversation metadata from the DB (plaintext).
 *   2. Read all raw encrypted message rows from the DB (already encrypted
 *      with the user's device key - no double work needed).
 *   3. Serialise everything to JSON.
 *   4. Wrap the whole JSON in one additional ChaCha20-Poly1305 layer
 *      using the WASM `encrypt_with_key` helper.  This protects conversation
 *      names and other metadata that are stored plaintext in the DB.
 *   5. Prepend a 4-byte magic header and return the binary blob.
 *
 * Import flow (same device key) - NON-DESTRUCTIVE MERGE:
 *   1. Strip magic header, decrypt outer envelope with device key.
 *   2. Parse JSON - validate version field. Compare `exporterDeviceId` with
 *      the current device's ID:
 *        - Same device (wipe/restore): conversations keep their `lifecycle`,
 *          MLS state IS valid and can be restored.
 *        - Different device (second phone/PC): conversations are imported as
 *          `lifecycle: 'pending'` - the device is NOT yet a MLS member of those
 *          groups.  MLS state from the backup must NOT be restored (the private
 *          leaf key belongs to the exporter, not to this device).
 *   3. `mergeConversation` (INSERT OR IGNORE) - live metadata is preserved.
 *   4. `importEncryptedRow` (INSERT OR IGNORE) - newer local messages kept.
 *   5. Returns `{ data, isSameDevice }` so the caller can decide what to do
 *      with the MLS state and can trigger Device A re-invitation flow.
 *
 * File format (v3, written since 2026-10-22 - see `crypto/backupRecoveryCode.ts`):
 *   [magic "CAN\x03"] [HKDF salt 16] [AES-GCM IV 12] [AES-256-GCM(JSON payload)]
 * sealed under a key derived from a RECOVERY CODE generated at export and shown once - never the
 * device key, which on a phone is random, hardware-held, and opens nothing on another device. Every
 * message row and seed in the payload is RE-SEALED from the device key to that same backup key, and
 * re-sealed again under the importing device's key on import, so the file carries no device key.
 *
 * File format (v2, still READ): [magic "CAN\x02"] [WASM-encrypted JSON payload], the envelope and
 * the rows under the exporting device's key - opens only where that key is the session's.
 *
 * Steps 1 and 4 above describe v2; v3 opens the envelope with the code and re-seals each row.
 *
 * The JSON payload:
 *   {
 *     version: 2,
 *     userId: string,
 *     exportedAt: number,
 *     exporterDeviceId: string,      // MLS device ID of the exporting device
 *     conversations: ConversationMeta[],
 *     messages: SerializedRow[],   // iv/cipherText as number[] (no salt)
 *     graine?: SerializedGraineRow[], // channel session seeds, still sealed
 *     mlsState?: string            // hex-encoded MLS state
 *   }
 *
 * `graine` is additive and OPTIONAL, and the version stays at 2 on purpose: nothing branches on
 * the version beyond rejecting 0, an older client ignores a field it does not know, and a backup
 * written before Graine simply has no seeds to restore.
 */

import type { IStorage, ConversationMeta } from './db';
import { openSealedBytes, sealBytes } from './encryption';
import {
  deriveBackupKeyB64,
  deviceKeyCheckValue,
  parseRecoveryCode,
} from './crypto/backupRecoveryCode';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SerializedRow {
  id: string;
  conversationId: string;
  timestamp: number;
  iv: number[];
  cipherText: number[];
}

/**
 * A Graine session row on the wire: the clear columns verbatim, and the sealed seed as `number[]`
 * like every other ciphertext in this file.
 *
 * The seed travels STILL ENCRYPTED - under the backup key in a v3 file, re-sealed under the
 * importing session's key on the way in (a v2 file carried it under the exporting device's key).
 * These rows are worth carrying because after Graine the server holds no channel key material, so a
 * seed lost here is channel history that has to be begged off a peer, or is gone.
 */
interface SerializedGraineRow {
  sessionId: string;
  workspaceId: string;
  channelId: string;
  senderId: string;
  firstIndex: number;
  createdAt: number;
  sentCount?: number;
  iv: number[];
  cipherText: number[];
}

export interface BackupData {
  version: number;
  userId: string;
  exportedAt: number;
  /** MLS device ID of the device that created this backup. */
  exporterDeviceId: string;
  conversations: ConversationMeta[];
  messages: SerializedRow[];
  /** Channel session seeds, sealed. Absent in backups written before Graine. */
  graine?: SerializedGraineRow[];
  /** Hex-encoded, device-key-encrypted MLS state (from localStorage). */
  mlsState?: string;
  /**
   * v3: the check value of the device key `mlsState` is sealed under (`deviceKeyCheckValue`), so an
   * import restores the state only where it opens - never the key itself.
   */
  mlsStateKeyCheck?: string;
}

/**
 * Why a backup could not be read, as a TYPE rather than as a sentence.
 *
 * Every refusal below used to be an `Error` carrying English prose, which reached only
 * `console.log` - so an import that refused the file looked exactly like one that worked. Telling
 * the user costs a translated sentence, and the layer that throws cannot know which language they
 * read in, so it does not write one: it names WHICH refusal happened, from a closed set, and the
 * surface picks the sentence.
 *
 * The set is what a READER distinguishes, not what the code checks. A dozen field-level checks all
 * mean one thing to somebody holding a file - "this is not a readable backup" - and splitting them
 * further would be a dozen sentences nobody can act on differently. What the developer needs
 * instead travels in `detail`, untranslated, straight to the log.
 */
export type BackupErrorCode =
  /** The file is not a Canari backup at all - the magic header is wrong or absent. */
  | 'not_a_backup'
  /** A v1 file, encrypted with the PIN rather than the device key. Nothing here can open it. */
  | 'too_old'
  /** The envelope did not open: a different device key, or damaged bytes. */
  | 'wrong_key'
  /** A v3 file and no recovery code, or a code that is not one (wrong length or alphabet). */
  | 'code_required'
  /** A v3 file whose envelope the typed recovery code does not open: another code, or damage. */
  | 'wrong_code'
  /** It opened, and what came out is not a backup this build can read. */
  | 'corrupted'
  /** Structurally fine and past a size this client refuses to load into memory. */
  | 'too_large';

/**
 * A refusal to read a backup, classified at the throw.
 *
 * `detail` is developer-facing and stays English: the offending id, the version number, the count
 * that was too big. It is what the log line needs and is never shown to a user - the sentence they
 * see comes from `code`.
 */
export class BackupError extends Error {
  constructor(
    readonly code: BackupErrorCode,
    readonly detail: string
  ) {
    super(`[BACKUP] ${code}: ${detail}`);
    this.name = 'BackupError';
  }
}

// Magic header: bytes for 'C', 'A', 'N', then the file version (2: device key, 3: recovery code).
const MAGIC = new Uint8Array([0x43, 0x41, 0x4e, 0x03]);

/** The v3 header after the magic: the HKDF salt, then the envelope's AES-GCM IV. */
const V3_SALT_BYTES = 16;
const V3_IV_BYTES = 12;

/**
 * The file version of `fileData`, or `null` when it is not a Canari backup. Lets the surface ask for
 * the recovery code BEFORE an import of a v3 file, rather than learning it from a refusal.
 */
export function backupFileVersion(fileData: Uint8Array): number | null {
  if (
    fileData.length < 4 ||
    fileData[0] !== MAGIC[0] ||
    fileData[1] !== MAGIC[1] ||
    fileData[2] !== MAGIC[2]
  ) {
    return null;
  }
  return fileData[3];
}

/**
 * Re-seals every row from one key to another, row by row. A row that does not open under `fromKey`
 * is LEFT OUT and counted: on export it is under a key older still (a seed a pre-fix recovery
 * stranded), and on import it cannot be a row of this file. Both callers log the count.
 */
async function resealRows<T extends { iv: Uint8Array; cipherText: Uint8Array }>(
  rows: T[],
  fromKeyB64: string,
  toKeyB64: string
): Promise<{ rows: T[]; unreadable: number }> {
  const out: T[] = [];
  let unreadable = 0;
  for (const row of rows) {
    const plain = await openSealedBytes(row.cipherText, row.iv, fromKeyB64);
    if (!plain) {
      unreadable += 1;
      continue;
    }
    const sealed = await sealBytes(plain, toKeyB64);
    out.push({ ...row, iv: sealed.iv, cipherText: sealed.cipherText });
  }
  return { rows: out, unreadable };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Serialise and encrypt the entire local DB into a single binary blob.
 *
 * @param storage          Initialised IStorage instance.
 * @param userId           Current user identifier.
 * @param deviceKeyB64     Base64-encoded 32-byte device key used as encryption key.
 * @param deviceId         MLS device ID of the exporting device (used on import
 *                         to detect same-device restore vs. second-device transfer).
 * @param mlsStateHex      Optional hex string of the encrypted MLS state from
 *                         localStorage - valid only for same-device restores.
 * @param recoveryCode     The 16 bytes of the device's recovery code
 *                         (`crypto/deviceRecoveryCode.ts`), shown to the user by the caller.
 * @returns Binary blob ready to be saved / downloaded as a .canari file.
 */
export async function exportBackup(
  storage: IStorage,
  userId: string,
  deviceKeyB64: string,
  deviceId: string,
  mlsStateHex: string | undefined,
  recoveryCode: Uint8Array
): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(V3_SALT_BYTES));
  const backupKeyB64 = await deriveBackupKeyB64(recoveryCode, salt);
  const conversations = await storage.getConversations();

  const movedMessages = await resealRows(
    await storage.getAllEncryptedRows(),
    deviceKeyB64,
    backupKeyB64
  );
  const messages: SerializedRow[] = movedMessages.rows.map((r) => ({
    id: r.id,
    conversationId: r.conversationId,
    timestamp: r.timestamp,
    iv: Array.from(r.iv),
    cipherText: Array.from(r.cipherText),
  }));

  const movedGraine = await resealRows(
    await storage.getAllEncryptedGraineRows(),
    deviceKeyB64,
    backupKeyB64
  );
  if (movedMessages.unreadable + movedGraine.unreadable > 0) {
    console.warn(
      `[BACKUP] ${movedMessages.unreadable} message(s) and ${movedGraine.unreadable} seed(s) do not open under the session key - left out of the backup`
    );
  }
  const rawGraine = movedGraine.rows;
  const graine: SerializedGraineRow[] = rawGraine.map((r) => ({
    sessionId: r.sessionId,
    workspaceId: r.workspaceId,
    channelId: r.channelId,
    senderId: r.senderId,
    firstIndex: r.firstIndex,
    createdAt: r.createdAt,
    ...(r.sentCount === undefined ? {} : { sentCount: r.sentCount }),
    iv: Array.from(r.iv),
    cipherText: Array.from(r.cipherText),
  }));

  const backup: BackupData = {
    version: 3,
    userId,
    exportedAt: Date.now(),
    exporterDeviceId: deviceId,
    conversations,
    messages,
    graine,
    mlsState: mlsStateHex,
    mlsStateKeyCheck: mlsStateHex ? await deviceKeyCheckValue(deviceKeyB64) : undefined,
  };

  const plaintext = new TextEncoder().encode(JSON.stringify(backup));
  const sealed = await sealBytes(plaintext, backupKeyB64);

  const result = new Uint8Array(
    MAGIC.length + V3_SALT_BYTES + V3_IV_BYTES + sealed.cipherText.length
  );
  result.set(MAGIC);
  result.set(salt, MAGIC.length);
  result.set(sealed.iv, MAGIC.length + V3_SALT_BYTES);
  result.set(sealed.cipherText, MAGIC.length + V3_SALT_BYTES + V3_IV_BYTES);
  return result;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * Decrypt and restore a .canari backup file to the local DB.
 *
 * Reads v3 (recovery code) and v2 (device key). A v1 file is encrypted with the PIN, which is not
 * available here, so it is refused outright - the doc used to promise a `decrypt_with_pin` fallback
 * that no longer exists.
 *
 * @param fileData         Raw bytes of the backup file.
 * @param deviceKeyB64     Base64-encoded 32-byte device key of THIS session: what the restored rows
 *                         are sealed under (v3), or what must open the envelope (v2).
 * @param storage          Initialised IStorage instance on the importing device.
 * @param currentDeviceId  MLS device ID of the current device.
 * @param recoveryCode     The code shown at export, as typed - required for a v3 file
 *                         ({@link backupFileVersion} tells the surface before it asks).
 * @returns `{ data, isSameDevice, mlsStateUsable }` - `isSameDevice` is true when the backup
 *          was created on this same device (wipe + restore scenario); `mlsStateUsable` when the
 *          MLS state it carries is sealed under this session's key, the only case it may be restored.
 * @throws  If the magic header is wrong, the key or code is incorrect, or the backup
 *          format is unsupported.
 */
export async function importBackup(
  fileData: Uint8Array,
  deviceKeyB64: string,
  storage: IStorage,
  currentDeviceId: string,
  recoveryCode?: string
): Promise<{ data: BackupData; isSameDevice: boolean; mlsStateUsable: boolean }> {
  const backupVersion = backupFileVersion(fileData);
  if (backupVersion === null) {
    throw new BackupError('not_a_backup', `magic header mismatch (${fileData.length} bytes)`);
  }

  // A v1 file is encrypted with the PIN (Argon2id + salt prefix), not with the device key, so it
  // cannot be opened here at all. The check sits ABOVE the try on purpose: raising it from inside
  // meant the catch below swallowed it, and the only way back out was to recognise the sentence it
  // had just thrown - a branch on prose that any rewording would have broken silently.
  if (backupVersion < 2) {
    throw new BackupError('too_old', `file version ${backupVersion}, this build reads 2+`);
  }
  if (backupVersion > 3) {
    throw new BackupError('corrupted', `file version ${backupVersion}, this build reads 2 and 3`);
  }

  // Decrypt outer envelope. v3: the recovery code's key, and every row is re-sealed below.
  let decrypted: Uint8Array;
  /** v3: the key the rows in the file are sealed under. `null` for v2, whose rows are the session's. */
  let fileRowKeyB64: string | null = null;
  if (backupVersion === 3) {
    const code = recoveryCode ? parseRecoveryCode(recoveryCode) : null;
    if (!code) throw new BackupError('code_required', 'v3 file, no well-formed recovery code');
    const header = 4 + V3_SALT_BYTES + V3_IV_BYTES;
    if (fileData.length <= header) {
      throw new BackupError('corrupted', `v3 file of ${fileData.length} bytes`);
    }
    fileRowKeyB64 = await deriveBackupKeyB64(code, fileData.slice(4, 4 + V3_SALT_BYTES));
    const opened = await openSealedBytes(
      fileData.slice(header),
      fileData.slice(4 + V3_SALT_BYTES, header),
      fileRowKeyB64
    );
    if (!opened) {
      console.warn('[BACKUP] the recovery code does not open the envelope');
      throw new BackupError('wrong_code', 'AES-GCM tag did not verify under the code');
    }
    decrypted = opened;
  } else {
    const wasm = await import('$lib/wasm/mls_wasm.js');
    try {
      decrypted = wasm.decrypt_with_key(deviceKeyB64, fileData.slice(4));
    } catch (err) {
      // The underlying cause does not survive the classification, so it is logged before it is lost.
      console.warn(`[BACKUP] Outer envelope decrypt failed: ${String(err)}`);
      throw new BackupError('wrong_key', String(err));
    }
  }

  // The envelope opened, so the bytes are ours and the key was right - but a truncated file
  // decrypts to truncated JSON, and this was the one refusal with no classification at all: it
  // escaped as a raw SyntaxError that no caller could tell from a bug.
  let backup: BackupData;
  try {
    backup = JSON.parse(new TextDecoder().decode(decrypted)) as BackupData;
  } catch (err) {
    throw new BackupError('corrupted', `payload is not JSON: ${String(err)}`);
  }

  if (backup.version < 1) {
    throw new BackupError('corrupted', `payload version ${backup.version}`);
  }

  // Validate backup structure
  if (!Array.isArray(backup.conversations)) {
    throw new BackupError('corrupted', 'conversations is not an array');
  }
  if (!Array.isArray(backup.messages)) {
    throw new BackupError('corrupted', 'messages is not an array');
  }
  if (backup.conversations.length > 10_000) {
    throw new BackupError('too_large', `${backup.conversations.length} conversations, max 10000`);
  }
  if (backup.messages.length > 500_000) {
    throw new BackupError('too_large', `${backup.messages.length} messages, max 500000`);
  }
  // M3: Validate string field sizes to prevent OOM on malformed backups.
  for (const conv of backup.conversations) {
    if (typeof conv.id !== 'string' || !conv.id.trim()) {
      throw new BackupError('corrupted', 'a conversation has no usable id');
    }
    if (typeof conv.name === 'string' && conv.name.length > 500) {
      throw new BackupError('corrupted', `conversation ${conv.id}: name over 500 characters`);
    }
  }

  // Detect whether this is the same physical device (wipe/restore) or a
  // second device receiving a transfer.  Back-compat: old backups without
  // exporterDeviceId are treated as same-device to preserve previous behaviour.
  const isSameDevice = !backup.exporterDeviceId || backup.exporterDeviceId === currentDeviceId;

  // Build a set of groupIds already present locally so we can skip backup
  // conversations that map to an already-tracked group (possibly under a
  // different key / conversation name).  Without this guard, a backup made
  // after a conversation rename would insert a second entry for the same MLS
  // group, causing duplicated UI entries that share a single MLS state.
  const existingConvs = await storage.getConversations();
  const existingGroupIds = new Set(existingConvs.map((c) => c.id));

  // H4: Validate all message rows before writing anything.
  // This prevents partial imports where conversations are inserted but messages fail.
  for (const msg of backup.messages) {
    if (typeof msg.id !== 'string' || !msg.id.trim()) {
      throw new BackupError('corrupted', 'a message has no usable id');
    }
    if (typeof msg.conversationId !== 'string') {
      throw new BackupError('corrupted', `message ${msg.id}: no conversationId`);
    }
    if (!Array.isArray(msg.iv) || !Array.isArray(msg.cipherText)) {
      throw new BackupError('corrupted', `message ${msg.id}: iv/cipherText are not arrays`);
    }
  }

  // Same treatment for the seeds: validated in full BEFORE anything is written, so a malformed
  // row cannot leave half a community restored.
  const graineRows = Array.isArray(backup.graine) ? backup.graine : [];
  if (graineRows.length > 100_000) {
    throw new BackupError('too_large', `${graineRows.length} channel sessions, max 100000`);
  }
  for (const row of graineRows) {
    if (typeof row.sessionId !== 'string' || !row.sessionId.trim()) {
      throw new BackupError('corrupted', 'a channel session has no usable id');
    }
    if (typeof row.channelId !== 'string' || typeof row.workspaceId !== 'string') {
      throw new BackupError('corrupted', `session ${row.sessionId}: no channel or community`);
    }
    if (!Array.isArray(row.iv) || !Array.isArray(row.cipherText)) {
      throw new BackupError('corrupted', `session ${row.sessionId}: iv/cipherText are not arrays`);
    }
  }

  // Merge conversation metadata: INSERT OR IGNORE so a device that already
  // has the conversation keeps its live (newer) state.
  // On a different device, force lifecycle = 'pending': the device is not yet a
  // cryptographic member of these groups and must wait for Welcome messages.
  for (const conv of backup.conversations) {
    // Skip if another local conversation already covers this MLS group.
    if (existingGroupIds.has(conv.id)) continue;
    await storage.mergeConversation(isSameDevice ? conv : { ...conv, lifecycle: 'pending' });
  }

  // Merge message rows: INSERT OR IGNORE so messages received on this device
  // after the backup was taken are never overwritten.
  // Only import rows whose conversationId is either already local or was just
  // inserted from this backup (skip orphan rows for skipped conversations).
  const allConvsAfterMerge = await storage.getConversations();
  const knownConvIds = new Set(allConvsAfterMerge.map((c) => c.id));
  /** v3 rows go from the file's key to this session's; v2 rows are the session's already. */
  const intoSessionKey = async (iv: number[], cipherText: number[]) => {
    const row = { iv: new Uint8Array(iv), cipherText: new Uint8Array(cipherText) };
    if (!fileRowKeyB64) return row;
    const moved = await resealRows([row], fileRowKeyB64, deviceKeyB64);
    return moved.rows[0] ?? null;
  };
  let unreadableRows = 0;
  for (const msg of backup.messages) {
    if (!knownConvIds.has(msg.conversationId)) continue;
    const sealed = await intoSessionKey(msg.iv, msg.cipherText);
    if (!sealed) {
      unreadableRows += 1;
      continue;
    }
    await storage.importEncryptedRow({
      id: msg.id,
      conversationId: msg.conversationId,
      timestamp: msg.timestamp,
      ...sealed,
    });
  }

  // Seeds are restored on BOTH device paths, unlike conversations. A conversation is forced to
  // `pending` on a second device because that device is not yet an MLS member and must wait for a
  // Welcome; a Graine seed carries no such membership - it is a symmetric key, re-sealed under this
  // session's key, and it opens exactly the messages it always opened.
  for (const row of graineRows) {
    const sealed = await intoSessionKey(row.iv, row.cipherText);
    if (!sealed) {
      unreadableRows += 1;
      continue;
    }
    await storage.importEncryptedGraineRow({
      sessionId: row.sessionId,
      workspaceId: row.workspaceId,
      channelId: row.channelId,
      senderId: typeof row.senderId === 'string' ? row.senderId : '',
      firstIndex: Number(row.firstIndex) || 0,
      createdAt: Number(row.createdAt) || 0,
      sentCount: row.sentCount,
      ...sealed,
    });
  }
  if (unreadableRows > 0) {
    console.warn(`[BACKUP] ${unreadableRows} row(s) of the file did not open - not restored`);
  }

  // The MLS state is sealed under the EXPORTING session's key. A v2 envelope that opened proves
  // that key is this session's; a v3 file says so only through its check value - after a wipe, a
  // phone's hardware-held key is a new one, and restoring a state it cannot open would refuse the
  // next unlock.
  const mlsStateUsable =
    fileRowKeyB64 === null ||
    (!!backup.mlsStateKeyCheck &&
      backup.mlsStateKeyCheck === (await deviceKeyCheckValue(deviceKeyB64)));

  return { data: backup, isSameDevice, mlsStateUsable };
}
