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

/**
 * The per-account key builders. The second argument of a two-part key is a group or a device.
 *
 * EVERY WRITER, READER AND SWEEPER OF A PER-ACCOUNT KEY BUILDS IT HERE - a module keeping its own
 * `const PREFIX = '...'` is how a key escapes the deletion's sweep. `accountLocalKeys.guard.test.ts`
 * scans the source for both shapes (one of these key literals outside this file, and a storage key
 * built inline) and fails on either.
 */
export const ACCOUNT_KEY = {
  /** `sendRatchetLedger.ts`: what this device's send ratchets have spent. */
  sendRatchetLedger: (userId: string) => `mls_send_ledger_${userId}`,
  /**
   * `BaseMlsService.resolveDeviceId`: this install's device id for the account. Called with `''` it
   * is the prefix `wasmPrefetch.ts` and `deviceReset.ts` enumerate.
   */
  deviceId: (userId: string) => `mls_device_id_${userId}`,
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
  /**
   * `salonUnsent.ts`: the PLAINTEXT of salon messages not yet sent (lower-cased, as it always was) -
   * the one key here whose content alone makes leaving it behind a leak.
   */
  salonUnsent: (userId: string) => `canari.salon-unsent.${userId.toLowerCase()}`,
  /** `salonReadMarkQueue.ts`: the salon read marks still owed to the server (lower-cased). */
  salonReadMarks: (userId: string) => `canari.salonReadMarks.${userId.toLowerCase()}`,
  /**
   * `feedStoreEpoch.ts`: the account's stored-feed epoch. Called with `''` it is the prefix a
   * sign-out enumerates to end EVERY account's epoch.
   */
  feedStoreEpoch: (userId: string) => `canari_feed_store_epoch:v1:${userId}`,
  /** `hex.ts`: the MLS state of builds that kept it in `localStorage`, read once and migrated. */
  legacyMlsAutosave: (userId: string) => `mls_autosave_${userId}`,
  /**
   * `sessionAuth.ts`: when the account last opened a session - in `localStorage` AND, on Tauri, in
   * the {@link SESSION_META_STORE} native store, which the deletion clears too.
   */
  lastActive: (userId: string) => `canari_last_active:${userId}`,
  /** No longer written; removed by the device reset and the deletion where an old build left it. */
  syncGuideSeen: (userId: string) => `canari_sync_guide_seen_${userId}`,
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
  /** `notReadyRegistry.ts`: since when one group has been not-ready-and-recoverable. */
  notReadySince: (userId: string, groupId: string) => `mls_not_ready_since:${userId}:${groupId}`,
  /** `WebMlsService` / `TauriMlsService`: the name this device announces for the account. */
  deviceName: (userId: string, deviceId: string) => `device-name:${userId}:${deviceId}`,
} as const;

/** The Tauri store (`@tauri-apps/plugin-store`) that mirrors {@link ACCOUNT_KEY}`.lastActive`. */
export const SESSION_META_STORE = 'session-meta.json';

/**
 * THE PLATFORM-KEYSTORE ALIAS of one account's device key - not a `localStorage` key, but named by
 * the same two ids, and the ONE builder every TypeScript caller uses (the unlock, the biometric
 * toggle, the key rotation, the device reset and the deletion). The native side builds the same
 * shape in `commands/mls.rs` and `commands/push.rs`; this is the TypeScript half.
 */
export function keystoreAlias(userId: string, deviceId: string): string {
  return `mls_device_key_${userId}_${deviceId}`;
}

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
    ACCOUNT_KEY.salonUnsent(userId),
    ACCOUNT_KEY.salonReadMarks(userId),
    ACCOUNT_KEY.feedStoreEpoch(userId),
    ACCOUNT_KEY.legacyMlsAutosave(userId),
    ACCOUNT_KEY.syncGuideSeen(userId),
    ACCOUNT_KEY.lastActive(userId),
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
    ACCOUNT_KEY.notReadySince(userId, ''),
    ACCOUNT_KEY.deviceName(userId, ''),
  ];
}

/** The exact-key builders whose key ends in the id AS WRITTEN, so a key names its account back. */
const ID_NAMING_KEYS = [
  ACCOUNT_KEY.deviceId,
  ACCOUNT_KEY.sendRatchetLedger,
  ACCOUNT_KEY.deviceKeyEpoch,
  ACCOUNT_KEY.seenCipherIndex,
  ACCOUNT_KEY.feedStoreEpoch,
] as const;

/**
 * The OTHER account ids this device holds data for that differ from `userId` only by letter case.
 *
 * TWO IDS THAT CASE-FOLD TOGETHER SHARE STORAGE. Three keys lower-case the id (`archivedConversations`,
 * `salonUnsent`, `salonReadMarks`), and the native database file `canari_<id>.db` lives on a
 * case-INSENSITIVE filesystem on Windows and macOS: wiping `Abc` there would remove `abc`'s unsent
 * texts and its database. MiConnect subjects are not promised to be case-distinct-safe, so a deletion
 * asks this first and REFUSES when it is not empty - never a guess at which rows are whose.
 */
export function caseCollidingAccountIdsIn(store: Storage, userId: string): string[] {
  const folded = userId.toLowerCase();
  const prefixes = ID_NAMING_KEYS.map((build) => build(''));
  const found = new Set<string>();
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (key === null) continue;
    for (const prefix of prefixes) {
      if (!key.startsWith(prefix)) continue;
      const id = key.slice(prefix.length);
      if (id !== userId && id.toLowerCase() === folded) found.add(id);
    }
  }
  return [...found];
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
