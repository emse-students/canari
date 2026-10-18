/**
 * EVERY `localStorage` KEY THAT BELONGS TO ONE ACCOUNT, IN ONE PLACE.
 *
 * The modules that read and write these keys build them HERE rather than inline, so the list an
 * account deletion sweeps ({@link accountLocalStorageKeysIn}) cannot drift from what the app writes:
 * a new per-account key that is not added to {@link ACCOUNT_KEY} is a key a deletion leaves behind,
 * and the place to add it is the one the writer already imports.
 *
 * THE ID IS PART OF THE KEY, SO IT MUST NOT BE ABLE TO REACH ANOTHER ACCOUNT'S. The user id is the
 * MiConnect `sub` (a `varchar(255)` the server copies as it comes), and the prefix-shaped keys below
 * end in `:<id>:` - an id holding `:` would make account `a`'s prefix match account `a:b`'s keys. A
 * deletion therefore runs only for an id that {@link isWipeableAccountId} accepts: the SAME allowlist
 * the native `delete_user_database` command applies, `[A-Za-z0-9_.@-]`, which covers a UUID, a hashed
 * `sub`, a username and an email address. Anything else is REFUSED loudly, never sanitised: a
 * normalised id would name a different account than the one the app wrote under.
 */

import { MLS_DEVICE_ID_PREFIX } from '$lib/mls-client/wasmPrefetch';

/** The per-account key builders. The second argument of a two-part key is a group or a device. */
export const ACCOUNT_KEY = {
  /** `sendRatchetLedger.ts`: what this device's send ratchets have spent. */
  sendRatchetLedger: (userId: string) => `mls_send_ledger_${userId}`,
  /** `BaseMlsService.resolveDeviceId`: this install's device id for the account. */
  deviceId: (userId: string) => `${MLS_DEVICE_ID_PREFIX}${userId}`,
  /** `deviceKeyGate.ts`: the device-key change epoch. */
  deviceKeyEpoch: (userId: string) => `canari-device-key-epoch:${userId}`,
  /** `conversations.ts`: the archived conversation ids (lower-cased, as it always was). */
  archivedConversations: (userId: string) =>
    `canari_archived_conversations_${userId.toLowerCase()}`,
  /** `seenLedgerBounds.ts`: the index of the per-group seen ledgers. */
  seenCipherIndex: (userId: string) => `history_seen_cipher_index:${userId}`,
  /**
   * The "this history ask was answered I-hold-nothing" record of pull request #2027
   * (`utils/graine/historyAnswered.ts`), which builds its key from here once both are merged.
   */
  historyHeldNothing: (userId: string) => `canari_graine_history_held_nothing:v1:${userId}`,
  /** `history.ts`: the processed-ciphertext fingerprints of one group. */
  seenCipher: (userId: string, groupId: string) => `history_seen_cipher:${userId}:${groupId}`,
  /** `history.ts`: the last stream id fetched for one group. */
  lastStreamId: (userId: string, groupId: string) => `history_last_stream_id:${userId}:${groupId}`,
  /** `history.ts`: the retry counters of one group's undecryptable frames. */
  retryCipher: (userId: string, groupId: string) => `history_retry_cipher:${userId}:${groupId}`,
  /** `historyReconcile.ts`: when this device was last connected. */
  lastConnected: (userId: string, deviceId: string) =>
    `history_last_connected:${userId}:${deviceId}`,
  /** `historyReconcile.ts`: the history audit generation of this device. */
  historyAudit: (userId: string, deviceId: string) => `history_audit:${userId}:${deviceId}`,
} as const;

/** The account-id allowlist, shared with the native `remove_user_database` (`storage.rs`). */
const WIPEABLE_ACCOUNT_ID = /^[A-Za-z0-9_.@-]{1,255}$/;

/** Whether `userId` may name the keys, databases and files an account deletion removes. */
export function isWipeableAccountId(userId: string): boolean {
  return WIPEABLE_ACCOUNT_ID.test(userId);
}

/** The exact keys of `userId`. */
function exactKeys(userId: string): string[] {
  return [
    ACCOUNT_KEY.sendRatchetLedger(userId),
    ACCOUNT_KEY.deviceId(userId),
    ACCOUNT_KEY.deviceKeyEpoch(userId),
    ACCOUNT_KEY.archivedConversations(userId),
    ACCOUNT_KEY.seenCipherIndex(userId),
    ACCOUNT_KEY.historyHeldNothing(userId),
  ];
}

/** The prefixes of `userId`'s two-part keys: each builder with an empty second part. */
function keyPrefixes(userId: string): string[] {
  return [
    ACCOUNT_KEY.seenCipher(userId, ''),
    ACCOUNT_KEY.lastStreamId(userId, ''),
    ACCOUNT_KEY.retryCipher(userId, ''),
    ACCOUNT_KEY.lastConnected(userId, ''),
    ACCOUNT_KEY.historyAudit(userId, ''),
  ];
}

/**
 * The keys of `store` that belong to `userId`, and ONLY those: an ALLOWLIST of the shapes above, so
 * a key nobody listed is never removed. Throws for an id {@link isWipeableAccountId} refuses.
 */
export function accountLocalStorageKeysIn(store: Storage, userId: string): string[] {
  if (!isWipeableAccountId(userId)) {
    throw new Error('refusing an account id outside the allowlist');
  }
  const exact = new Set(exactKeys(userId));
  const prefixes = keyPrefixes(userId);
  const found: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (key === null) continue;
    if (exact.has(key) || prefixes.some((p) => key.startsWith(p))) found.push(key);
  }
  return found;
}
