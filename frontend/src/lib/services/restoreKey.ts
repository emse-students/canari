/**
 * THE RESTORE KEY ON THIS INSTALL - the native calls and the two local markers (WP-RESTORE-1,
 * docs/wiki/account-restore.md).
 *
 * Kept apart from the flows (`restoreCredential.ts`) so that `auth.ts` can clear the key at every
 * sign-out and drop the markers at every sign-in without importing the module that imports it.
 *
 * ANDROID ONLY. The Restore Credentials API exists on Android alone; on every other platform each
 * call here is a no-op that says why, at debug level - it is the expected answer there, not a defect.
 */

import { invoke } from '@tauri-apps/api/core';
import { isAndroidTauriRuntime } from '$lib/utils/appVersion';
import { restoreCommand } from '$lib/services/restoreCommands';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';

/**
 * Per account: the {@link RestoreKeyRecord} of the current session - built by
 * `ACCOUNT_KEY.restoreKeyRegistered`, so an account deletion sweeps it. A key is per SESSION, so
 * every session mint drops it ({@link forgetRestoreKeyRegistrations}); this is the prefix that does.
 */
export const RESTORE_REGISTERED_PREFIX = ACCOUNT_KEY.restoreKeyRegistered('');

/**
 * Per install: "this install has already been signed into, out of, or asked the platform for a
 * restored key". The attempt is for the FIRST start of a fresh install and nothing else: on a phone
 * that was signed out, a key the server could not be told about (an offline sign-out) would
 * otherwise sign the user straight back in. localStorage is not in the Android backup
 * (`allowBackup` is off), so a restored phone starts without it.
 */
export const RESTORE_ATTEMPTED_KEY = 'canari_restore_attempted';

const rlog = (msg: string) => console.log('[RESTORE] ' + msg);
const rwarn = (msg: string) => console.warn('[RESTORE] ' + msg);

/** What the platform answered to a registration: the WebAuthn response and the backup mode. */
export interface CreatedRestoreKey {
  responseJson: string;
  cloudBackup: boolean;
}

/** What the platform answered to an assertion: the signed response, or no key on this phone. */
export type FoundRestoreKey = { absent: true } | { absent: false; responseJson: string };

/** Whether this platform has a restore key at all. */
export function restoreKeySupported(): boolean {
  return isAndroidTauriRuntime();
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch (e) {
    rwarn(`localStorage unreadable (${key}): ${String(e)}`);
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch (e) {
    rwarn(`localStorage unwritable (${key}): ${String(e)}`);
  }
}

/**
 * What this install knows of the restore key of `userId`'s current session, kept apart because the
 * two can differ for a moment and each difference means something else:
 * - `held`: the key the PLATFORM holds - written the instant Credential Manager answers a create,
 *   BEFORE the server is told, since a create replaces the app's one key whatever happens next.
 *   Credential Manager has no read short of a signed assertion, so this record is how the install
 *   knows which key it holds.
 * - `registered`: the key the SERVER last confirmed for this session to this install.
 * A server key equal to `held` is this install's (a lost answer included); equal to `registered`
 * but not `held`, it is this install's previous key; anything else, nobody here put it there.
 */
export interface RestoreKeyRecord {
  held: string | null;
  registered: string | null;
}

/** Reads the {@link RestoreKeyRecord} of `userId`; an absent or unreadable one knows nothing. */
export function restoreKeyRecord(userId: string): RestoreKeyRecord {
  const raw = readStorage(ACCOUNT_KEY.restoreKeyRegistered(userId));
  if (raw === null) return { held: null, registered: null };
  try {
    const parsed = JSON.parse(raw) as Partial<RestoreKeyRecord>;
    return {
      held: typeof parsed.held === 'string' ? parsed.held : null,
      registered: typeof parsed.registered === 'string' ? parsed.registered : null,
    };
  } catch (e) {
    rwarn(`restore key record unreadable, treated as empty: ${String(e)}`);
    return { held: null, registered: null };
  }
}

/** Writes the {@link RestoreKeyRecord} of `userId`. */
export function writeRestoreKeyRecord(userId: string, record: RestoreKeyRecord): void {
  writeStorage(ACCOUNT_KEY.restoreKeyRegistered(userId), JSON.stringify(record));
}

/**
 * Drops every account's "registered" marker. Called at every session mint and every sign-out: the
 * key the marker spoke of belonged to a session that no longer is this install's.
 */
export function forgetRestoreKeyRegistrations(): void {
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(RESTORE_REGISTERED_PREFIX)) stale.push(key);
    }
    for (const key of stale) localStorage.removeItem(key);
    if (stale.length) rlog(`registration marker(s) dropped: ${stale.length}`);
  } catch (e) {
    rwarn(`registration markers could not be dropped: ${String(e)}`);
  }
}

/** Whether this install is past its first start (see {@link RESTORE_ATTEMPTED_KEY}). */
export function hasAttemptedRestore(): boolean {
  return readStorage(RESTORE_ATTEMPTED_KEY) !== null;
}

/** Records that this install is past its first start: no restore will be attempted again. */
export function markRestoreAttempted(): void {
  writeStorage(RESTORE_ATTEMPTED_KEY, '1');
}

/** Creates (or replaces) this install's key from the server's registration options. */
export async function createRestoreKey(options: unknown): Promise<CreatedRestoreKey> {
  return invoke<CreatedRestoreKey>(restoreCommand('create'), {
    requestJson: JSON.stringify(options),
  });
}

/** Asks the platform to sign the server's assertion options with a restored key. */
export async function getRestoreKey(options: unknown): Promise<FoundRestoreKey> {
  return invoke<FoundRestoreKey>(restoreCommand('get'), { requestJson: JSON.stringify(options) });
}

/**
 * Deletes this install's restore key, best effort. The server's copy already died with the session
 * when the sign-out reached it (the cascade); this removes the platform's copy so a later backup
 * carries nothing. Never throws: a sign-out does not wait on it, and a failure is logged.
 */
export async function clearRestoreKey(reason: string): Promise<void> {
  if (!restoreKeySupported()) return;
  try {
    await invoke(restoreCommand('clear'));
    rlog(`key cleared (${reason})`);
  } catch (e) {
    rwarn(`key NOT cleared (${reason}): ${String(e)}`);
  }
}
