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
  /**
   * `BaseMlsService.retireAbandonedDevices`: this install's OWN previous device ids, abandoned by a
   * rotation and not yet confirmed deleted on the server - a JSON array, emptied as each delete lands.
   */
  retiringDeviceIds: (userId: string) => `mls_retiring_device_ids_${userId}`,
  /**
   * `owedInvitations.ts`: the member invitations whose kept commit did not land, owed a re-plan -
   * group ids, epochs and the invited user ids, emptied as each re-plan concludes.
   */
  owedInvitations: (userId: string) => `mls_owed_invitations:v1:${userId}`,
  /**
   * `addLockMarkers.ts`: the add locks this device took and has not had a release ANSWERED for - per
   * group, the token of the acquisition, cleared when its release is answered.
   */
  addLockMarkers: (userId: string) => `mls_add_lock_markers:v1:${userId}`,
  /** `deviceKeyGate.ts`: the device-key change epoch. */
  deviceKeyEpoch: (userId: string) => `canari-device-key-epoch:${userId}`,
  /** `conversations.ts`: the archived conversation ids (lower-cased, as it always was). */
  archivedConversations: (userId: string) =>
    `canari_archived_conversations_${userId.toLowerCase()}`,
  /** `seenLedgerBounds.ts`: the index of the per-group seen ledgers. */
  seenCipherIndex: (userId: string) => `history_seen_cipher_index:${userId}`,
  /**
   * `graine/historyAnswered.ts`: the history asks answered "I hold nothing" - every community of the
   * account in one key, other members' ids included, all written by this account's device.
   */
  historyHeldNothing: (userId: string) => `canari_graine_history_held_nothing:v1:${userId}`,
  /**
   * `graine/admissionGate.ts`: what this device recorded by itself about who is admitted - per
   * community the roots and the admissions it verified. Other members' ids, written by this
   * account's device.
   */
  admissionLedger: (userId: string) => `canari_graine_admission_ledger:v1:${userId}`,
  /**
   * `graine/historyClosedSeen.ts`: the communities whose past this device was last told is closed
   * (`joined`) - community ids only, so a switch to `shared` re-asks their past.
   */
  historyClosedSeen: (userId: string) => `canari_graine_history_closed_seen:v1:${userId}`,
  /**
   * `graine/pagedHistoryAnswer.ts`: per community, the history ask in flight and which pages of a
   * paged answer to it arrived - request ids and page numbers only, no key material.
   */
  pagedHistoryAnswer: (userId: string) => `canari_graine_paged_history_answer:v1:${userId}`,
  /**
   * `salonUnsent.ts`: the PLAINTEXT of salon messages not yet sent (lower-cased, as it always was) -
   * the one key here whose content alone makes leaving it behind a leak.
   */
  salonUnsent: (userId: string) => `canari.salon-unsent.${userId.toLowerCase()}`,
  /** `salonReadMarkQueue.ts`: the salon read marks still owed to the server (lower-cased). */
  salonReadMarks: (userId: string) => `canari.salonReadMarks.${userId.toLowerCase()}`,
  /** `salonReadMarkQueue.ts`: the DM and group read marks still owed to the outbox (lower-cased). */
  dmReadMarks: (userId: string) => `canari.dmReadMarks.${userId.toLowerCase()}`,
  /**
   * `controlRefusals.svelte.ts`: the reactions, edits, pins and deletes the outbox refused, still
   * offered for Retry - message and group ids, an emoji and instants, never a message's text.
   */
  controlRefusals: (userId: string) => `canari_control_refusals:v1:${userId}`,
  /**
   * `deviceNotices.svelte.ts`: the "new device on your account" alerts not yet seen, and the keys
   * already announced (`userId:deviceId|fingerprint`) - device ids and key fingerprints, no secret.
   */
  deviceNotices: (userId: string) => `canari_device_notices:v1:${userId}`,
  /**
   * `notifiedMessages.ts`: the message ids this account was already notified of on this device -
   * by this app or by the iOS notification extension - so no message is announced twice. Ids only.
   */
  notifiedMessages: (userId: string) => `canari_notified_messages:v1:${userId}`,
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
  /**
   * `migration.ts`: one conversation of the builds that kept them in PLAINTEXT `localStorage`, read
   * once and migrated. NOT swept as a prefix: `_` is in the id allowlist, so `canari_conv_a_` also
   * opens account `a_b`'s keys - see {@link legacyConversationKeysIn} for the rule that is.
   */
  legacyConversation: (userId: string, contactName: string) =>
    `canari_conv_${userId}_${contactName}`,
  /**
   * `restoreKey.ts`: the current session of the account has registered its restore key
   * (WP-RESTORE-1, Android). Called with `''` it is the prefix every session mint and sign-out drops.
   */
  restoreKeyRegistered: (userId: string) => `canari_restore_registered:${userId}`,
  /**
   * `deviceRecoveryCode.ts`: this device's backup recovery code, SEALED under the device key - one
   * code for every backup the device exports (decision of 2026-10-22).
   */
  backupRecoveryCode: (userId: string) => `canari_backup_recovery_code:v1:${userId}`,
  /**
   * `deviceRecoveryCode.ts`: set when the move to the hardware-held key re-sealed existing data, so
   * backups made before it no longer open here; cleared by the next export.
   */
  backupOwedAfterKeyMove: (userId: string) => `canari_backup_owed_after_key_move:v1:${userId}`,
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
  /** `leafRefresh.ts`: when this device's own commits last replaced its leaf, per group. */
  leafRefresh: (userId: string, deviceId: string) => `mls_leaf_refresh:${userId}:${deviceId}`,
  /**
   * `refusedDevices.ts`: the devices THIS device refused for a changed key, never fetched again - a
   * JSON array of `userId:deviceId`, keyed by this device because the pins are its own.
   */
  refusedDevices: (userId: string, deviceId: string) => `mls_refused_devices:${userId}:${deviceId}`,
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
    ACCOUNT_KEY.retiringDeviceIds(userId),
    ACCOUNT_KEY.owedInvitations(userId),
    ACCOUNT_KEY.addLockMarkers(userId),
    ACCOUNT_KEY.deviceKeyEpoch(userId),
    ACCOUNT_KEY.archivedConversations(userId),
    ACCOUNT_KEY.seenCipherIndex(userId),
    ACCOUNT_KEY.historyHeldNothing(userId),
    ACCOUNT_KEY.admissionLedger(userId),
    ACCOUNT_KEY.historyClosedSeen(userId),
    ACCOUNT_KEY.pagedHistoryAnswer(userId),
    ACCOUNT_KEY.salonUnsent(userId),
    ACCOUNT_KEY.salonReadMarks(userId),
    ACCOUNT_KEY.dmReadMarks(userId),
    ACCOUNT_KEY.controlRefusals(userId),
    ACCOUNT_KEY.deviceNotices(userId),
    ACCOUNT_KEY.notifiedMessages(userId),
    ACCOUNT_KEY.feedStoreEpoch(userId),
    ACCOUNT_KEY.legacyMlsAutosave(userId),
    ACCOUNT_KEY.syncGuideSeen(userId),
    ACCOUNT_KEY.lastActive(userId),
    ACCOUNT_KEY.restoreKeyRegistered(userId),
    ACCOUNT_KEY.backupRecoveryCode(userId),
    ACCOUNT_KEY.backupOwedAfterKeyMove(userId),
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
    ACCOUNT_KEY.leafRefresh(userId, ''),
    ACCOUNT_KEY.refusedDevices(userId, ''),
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
 * TWO IDS THAT CASE-FOLD TOGETHER SHARE STORAGE. Four keys lower-case the id (`archivedConversations`,
 * `salonUnsent`, `salonReadMarks`, `dmReadMarks`), and the native database file `canari_<id>.db`
 * lives on a case-INSENSITIVE filesystem on Windows and macOS: wiping `Abc` there would remove
 * `abc`'s unsent texts and its database. MiConnect subjects are not promised to be case-distinct-safe, so a deletion
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
 * `userId`'s legacy plaintext conversation keys ({@link ACCOUNT_KEY}`.legacyConversation`), split
 * into the ones PROVEN to be its own and the ones that may be another account's.
 *
 * THE RULE: `canari_conv_<id>_<rest>` is proven `<id>`'s when `<rest>` holds no `_`. Any account
 * whose id STARTS with `<id>_` - the only kind that can share the prefix - writes
 * `canari_conv_<id>_<more>_<contact>`, whose rest always holds one. A rest WITH a `_` (a contact
 * name carrying one, or another account's key) cannot be told apart, so it is `ambiguous`: kept, and
 * the deletion says how many.
 */
export function legacyConversationKeysIn(
  store: Storage,
  userId: string
): { proven: string[]; ambiguous: string[] } {
  const prefix = ACCOUNT_KEY.legacyConversation(userId, '');
  const proven: string[] = [];
  const ambiguous: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (key === null || !key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    if (rest.length > 0 && !rest.includes('_')) proven.push(key);
    else ambiguous.push(key);
  }
  return { proven, ambiguous };
}

/**
 * The keys of `store` that belong to `userId`, and ONLY those: an ALLOWLIST of the shapes above, so
 * a key nobody listed is never removed. Throws for an id {@link isWipeableAccountId} refuses.
 * The legacy conversations are included only where PROVEN ({@link legacyConversationKeysIn}).
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
  found.push(...legacyConversationKeysIn(store, userId).proven);
  return found;
}
