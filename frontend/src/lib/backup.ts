/**
 * backup.ts – Canari message backup / restore (WhatsApp-style)
 *
 * Export flow:
 *   1. Read all conversation metadata from the DB (plaintext).
 *   2. Read all raw encrypted message rows from the DB (already encrypted
 *      with the user's PIN – no double work needed).
 *   3. Serialise everything to JSON.
 *   4. Wrap the whole JSON in one additional Argon2+ChaCha20-Poly1305 layer
 *      using the WASM `encrypt_with_pin` helper.  This protects conversation
 *      names and other metadata that are stored plaintext in the DB.
 *   5. Prepend a 4-byte magic header and return the binary blob.
 *
 * Import flow (new device, same PIN) – NON-DESTRUCTIVE MERGE:
 *   1. Strip magic header, decrypt outer envelope with PIN.
 *   2. Parse JSON – validate version field. Compare `exporterDeviceId` with
 *      the current device's ID:
 *        - Same device (wipe/restore): conversations stay `isReady: true`,
 *          MLS state IS valid and can be restored.
 *        - Different device (second phone/PC): conversations are imported as
 *          `isReady: false` – the device is NOT yet a MLS member of those
 *          groups.  MLS state from the backup must NOT be restored (the private
 *          leaf key belongs to the exporter, not to this device).
 *   3. `mergeConversation` (INSERT OR IGNORE) – live metadata is preserved.
 *   4. `importEncryptedRow` (INSERT OR IGNORE) – newer local messages kept.
 *   5. Returns `{ data, isSameDevice }` so the caller can decide what to do
 *      with the MLS state and can trigger Device A re-invitation flow.
 *
 * File format:
 *   [magic: 4 bytes "CAN\x01"] [WASM-encrypted JSON payload]
 *
 * The JSON payload:
 *   {
 *     version: 1,
 *     userId: string,
 *     exportedAt: number,
 *     exporterDeviceId: string,      // MLS device ID of the exporting device
 *     conversations: ConversationMeta[],
 *     messages: SerializedRow[],   // iv/salt/cipherText as number[]
 *     mlsState?: string            // hex-encoded MLS state
 *   }
 */

import type { IStorage, ConversationMeta } from './db';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SerializedRow {
  id: string;
  conversationId: string;
  timestamp: number;
  iv: number[];
  salt: number[];
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
  /** Hex-encoded, PIN-encrypted MLS state (from localStorage). */
  mlsState?: string;
}

// Magic header: bytes for 'C', 'A', 'N', version=1
const MAGIC = new Uint8Array([0x43, 0x41, 0x4e, 0x01]);

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Serialise and encrypt the entire local DB into a single binary blob.
 *
 * @param storage      Initialised IStorage instance.
 * @param userId       Current user identifier.
 * @param pin          User PIN used as encryption key.
 * @param deviceId     MLS device ID of the exporting device (used on import
 *                     to detect same-device restore vs. second-device transfer).
 * @param mlsStateHex  Optional hex string of the encrypted MLS state from
 *                     localStorage – valid only for same-device restores.
 * @returns Binary blob ready to be saved / downloaded as a .canari file.
 */
export async function exportBackup(
  storage: IStorage,
  userId: string,
  pin: string,
  deviceId: string,
  mlsStateHex?: string
): Promise<Uint8Array> {
  const conversations = await storage.getConversations();
  const rawRows = await storage.getAllEncryptedRows();

  const messages: SerializedRow[] = rawRows.map((r) => ({
    id: r.id,
    conversationId: r.conversationId,
    timestamp: r.timestamp,
    iv: Array.from(r.iv),
    salt: Array.from(r.salt),
    cipherText: Array.from(r.cipherText),
  }));

  const backup: BackupData = {
    version: 1,
    userId,
    exportedAt: Date.now(),
    exporterDeviceId: deviceId,
    conversations,
    messages,
    mlsState: mlsStateHex,
  };

  const wasm = await import('$lib/wasm/mls_wasm.js');
  const plaintext = new TextEncoder().encode(JSON.stringify(backup));
  const encrypted: Uint8Array = wasm.encrypt_with_pin(pin, plaintext);

  const result = new Uint8Array(MAGIC.length + encrypted.length);
  result.set(MAGIC);
  result.set(encrypted, MAGIC.length);
  return result;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * Decrypt and restore a .canari backup file to the local DB.
 *
 * @param fileData         Raw bytes of the backup file.
 * @param pin              User PIN (must match the one used during export).
 * @param storage          Initialised IStorage instance on the importing device.
 * @param currentDeviceId  MLS device ID of the current device.  Used to detect
 *                         whether this is a same-device restore (safe to apply
 *                         the exporter's MLS state) or a second-device transfer
 *                         (MLS state must NOT be applied; conversations imported
 *                         as pending until Device A sends Welcomes).
 * @returns `{ data, isSameDevice }` — `isSameDevice` is true when the backup
 *          was created on this same device (wipe + restore scenario).
 * @throws  If the magic header is wrong, the PIN is incorrect, or the backup
 *          format is unsupported.
 */
export async function importBackup(
  fileData: Uint8Array,
  pin: string,
  storage: IStorage,
  currentDeviceId: string
): Promise<{ data: BackupData; isSameDevice: boolean }> {
  // Validate magic header
  if (
    fileData.length < 4 ||
    fileData[0] !== MAGIC[0] ||
    fileData[1] !== MAGIC[1] ||
    fileData[2] !== MAGIC[2] ||
    fileData[3] !== MAGIC[3]
  ) {
    throw new Error('Fichier de sauvegarde invalide ou corrompu.');
  }

  const encrypted = fileData.slice(4);

  // Decrypt outer envelope
  const wasm = await import('$lib/wasm/mls_wasm.js');
  let decrypted: Uint8Array;
  try {
    decrypted = wasm.decrypt_with_pin(pin, encrypted);
  } catch {
    throw new Error('PIN incorrect ou données corrompues.');
  }

  const backup: BackupData = JSON.parse(new TextDecoder().decode(decrypted));

  if (backup.version !== 1) {
    throw new Error(`Version de sauvegarde non supportée : ${backup.version}`);
  }

  // Detect whether this is the same physical device (wipe/restore) or a
  // second device receiving a transfer.  Back-compat: old backups without
  // exporterDeviceId are treated as same-device to preserve previous behaviour.
  const isSameDevice = !backup.exporterDeviceId || backup.exporterDeviceId === currentDeviceId;

  // Merge conversation metadata: INSERT OR IGNORE so a device that already
  // has the conversation keeps its live (newer) state.
  // On a different device, force isReady = false: the device is not yet a
  // cryptographic member of these groups and must wait for Welcome messages.
  for (const conv of backup.conversations) {
    await storage.mergeConversation(isSameDevice ? conv : { ...conv, isReady: false });
  }

  // Merge message rows: INSERT OR IGNORE so messages received on this device
  // after the backup was taken are never overwritten.
  for (const msg of backup.messages) {
    await storage.importEncryptedRow({
      id: msg.id,
      conversationId: msg.conversationId,
      timestamp: msg.timestamp,
      iv: new Uint8Array(msg.iv),
      salt: new Uint8Array(msg.salt),
      cipherText: new Uint8Array(msg.cipherText),
    });
  }

  return { data: backup, isSameDevice };
}
