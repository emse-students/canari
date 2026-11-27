import { liveDeviceKey, withDeviceKeyHeld } from '$lib/db/deviceKeyGate';
import { openSealedBytes, sealBytes } from '$lib/encryption';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import { Log } from '$lib/utils/Log';

/**
 * "RETENIR LE MOT DE PASSE" (docs/wiki/mail-client.md D6): the school mailbox's password, SEALED
 * under Canari's device key, so a lapsed Zimbra session is renewed without asking.
 *
 * The device key is the one every at-rest store of the account is under: on a phone a random key
 * held by the hardware keystore, on the web and the desktop the PIN-derived key
 * (docs/wiki/frontend/modules/auth.md#pin-and-device-key). Nothing new is invented: the seal is
 * `sealBytes` (AES-256-GCM, fresh IV), the very helper the backup recovery code uses, and the entry
 * lives where that code lives - `localStorage`, under an {@link ACCOUNT_KEY} builder, never in the
 * clear. Every device key change re-seals it beside the stores ({@link resealMailPassword}, called by
 * `pinChange.ts`), and the account deletion sweeps it with the account's other keys.
 *
 * The sealed plaintext names the mailbox it opens AND the Canari account it belongs to, both checked
 * when it is opened: a password is never tried against another address, and an entry copied under
 * another account's key does not open.
 *
 * An entry the device key does not open is REMOVED (by the session at a renewal, and by a key change
 * that opens it under neither key): it is our own allowlisted key, and a stale ciphertext under a
 * possibly leaked old key has no use.
 */

/** The stored shape: AES-GCM under the device key, base64. */
interface SealedEntry {
  v: 1;
  iv: string;
  ct: string;
}

/** What the seal holds (beside the Canari account id, checked at the open). */
export interface RememberedMailPassword {
  /** The mailbox address the password was given for. */
  account: string;
  password: string;
}

/** What reading the remembered password found. */
export type RememberedRead =
  /** Nothing is remembered on this device for this Canari account. */
  | { kind: 'none' }
  /** The entry is there and the device key opens it. */
  | { kind: 'opened'; remembered: RememberedMailPassword }
  /**
   * The entry is there and the device key does NOT open it (a key change that could not re-seal it,
   * an entry of another build or another account). The caller removes it ({@link forgetMailPassword}).
   */
  | { kind: 'unopenable' };

function toB64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromB64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function readEntry(store: Storage, userId: string): SealedEntry | 'absent' | 'foreign' {
  const raw = store.getItem(ACCOUNT_KEY.mailSealedPassword(userId));
  if (raw === null) return 'absent';
  try {
    const parsed = JSON.parse(raw) as Partial<SealedEntry>;
    if (parsed.v === 1 && typeof parsed.iv === 'string' && typeof parsed.ct === 'string') {
      return parsed as SealedEntry;
    }
  } catch {
    // Reported by the caller with the other shape refusal.
  }
  return 'foreign';
}

async function openWith(
  entry: SealedEntry,
  userId: string,
  deviceKeyB64: string
): Promise<RememberedMailPassword | null> {
  const plain = await openSealedBytes(fromB64(entry.ct), fromB64(entry.iv), deviceKeyB64);
  if (!plain) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(plain)) as Partial<
      RememberedMailPassword & { userId: string }
    >;
    if (
      parsed.userId === userId &&
      typeof parsed.account === 'string' &&
      typeof parsed.password === 'string'
    ) {
      return { account: parsed.account, password: parsed.password };
    }
  } catch {
    // A plaintext that is not ours: the same answer as a tag that does not verify.
  }
  return null;
}

/**
 * Seals and stores `remembered`. `stillWanted` is asked AFTER the seal, in the same synchronous step
 * as the write: a sign-out that forgot the password while this write waited (behind the gate, or on
 * the cipher) is honoured, never undone. Resolves whether it wrote.
 */
async function writeEntry(
  store: Storage,
  userId: string,
  remembered: RememberedMailPassword,
  deviceKeyB64: string,
  stillWanted: () => boolean = () => true
): Promise<boolean> {
  const plaintext = new TextEncoder().encode(JSON.stringify({ userId, ...remembered }));
  const { iv, cipherText } = await sealBytes(plaintext, deviceKeyB64);
  if (!stillWanted()) return false;
  const entry: SealedEntry = { v: 1, iv: toB64(iv), ct: toB64(cipherText) };
  store.setItem(ACCOUNT_KEY.mailSealedPassword(userId), JSON.stringify(entry));
  return true;
}

/**
 * Seals `remembered` under the device key, INSIDE the storage gate and under the key the stores are
 * under then ({@link liveDeviceKey}): a key change running meanwhile either re-seals this entry (it
 * entered first) or is already done (it is written under the new key). `stillWanted` is checked
 * right before the write; resolves whether the password was stored.
 */
export async function rememberMailPassword(
  userId: string,
  deviceKeyB64: string,
  remembered: RememberedMailPassword,
  store: Storage = localStorage,
  stillWanted: () => boolean = () => true
): Promise<boolean> {
  const written = await withDeviceKeyHeld(userId, () =>
    writeEntry(store, userId, remembered, liveDeviceKey(deviceKeyB64), stillWanted)
  );
  Log.d(
    'MAIL',
    written
      ? 'the mailbox password is remembered, sealed under the device key'
      : 'the mailbox password was not remembered: the session ended while it was sealed'
  );
  return written;
}

/** Reads the remembered password, inside the storage gate. */
export async function readRememberedMailPassword(
  userId: string,
  deviceKeyB64: string,
  store: Storage = localStorage
): Promise<RememberedRead> {
  return withDeviceKeyHeld(userId, async () => {
    const entry = readEntry(store, userId);
    if (entry === 'absent') return { kind: 'none' } as const;
    if (entry === 'foreign') {
      Log.w('MAIL', 'ERROR: the remembered mailbox password is not an entry this build wrote');
      return { kind: 'unopenable' } as const;
    }
    const remembered = await openWith(entry, userId, liveDeviceKey(deviceKeyB64));
    if (!remembered) {
      Log.w('MAIL', 'ERROR: the remembered mailbox password does not open under the device key');
      return { kind: 'unopenable' } as const;
    }
    return { kind: 'opened', remembered } as const;
  });
}

/** Forgets the remembered password (unticked, signed out, refused, unopenable). */
export function forgetMailPassword(userId: string, store: Storage = localStorage): void {
  if (store.getItem(ACCOUNT_KEY.mailSealedPassword(userId)) === null) return;
  store.removeItem(ACCOUNT_KEY.mailSealedPassword(userId));
  Log.d('MAIL', 'the remembered mailbox password is forgotten');
}

/**
 * Re-seals the remembered password from `oldDeviceKeyB64` to `newDeviceKeyB64` - a step of every
 * device key change, beside the sealed stores. IDEMPOTENT, so a change resumed after a kill runs it
 * again: an entry already under the new key is left; one under neither key (or not ours) is REMOVED
 * and logged - the next renewal finds nothing and asks for the password.
 */
export async function resealMailPassword(
  userId: string,
  oldDeviceKeyB64: string,
  newDeviceKeyB64: string,
  log: (msg: string) => void,
  store: Storage = localStorage
): Promise<void> {
  const entry = readEntry(store, userId);
  if (entry === 'absent') return;
  if (entry === 'foreign') {
    store.removeItem(ACCOUNT_KEY.mailSealedPassword(userId));
    log('[MAIL] ERROR: the remembered mailbox password is not an entry this build wrote - removed');
    return;
  }
  const underOld = await openWith(entry, userId, oldDeviceKeyB64);
  if (underOld) {
    await writeEntry(store, userId, underOld, newDeviceKeyB64);
    log('[MAIL] the remembered mailbox password is re-sealed under the new device key');
    return;
  }
  if (await openWith(entry, userId, newDeviceKeyB64)) return;
  store.removeItem(ACCOUNT_KEY.mailSealedPassword(userId));
  log('[MAIL] ERROR: the remembered mailbox password opens under neither key - removed');
}
