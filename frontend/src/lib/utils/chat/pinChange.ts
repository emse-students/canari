/**
 * Authenticated PIN change for a logged-in user.
 *
 * Unlike the destructive "forgot PIN" reset, this preserves all messages: the
 * in-memory MLS state (already decrypted at login) is re-encrypted under the new
 * PIN via {@link IMlsService.changePIN}, and the account-wide verifier is rotated
 * server-side after proving knowledge of the current PIN.
 *
 * Because the verifier is account-wide, the user's other devices keep their old
 * PIN locally and will hit a mismatch at their next login - they must re-enter the
 * new PIN (and re-enrol biometric). That is inherent: the PIN never leaves a device.
 */
import { computePinVerifier } from '$lib/utils/chat/auth';
import { savePin } from '$lib/utils/pinVault';
import { getToken } from '$lib/stores/auth';
import { BiometricService } from '$lib/services/biometric';
import { isTauriRuntime } from '$lib/utils/openExternal';
import type { IMlsService } from '$lib/mls-client';

/**
 * Refreshes this device's locally stored PIN material after the account PIN changed:
 * updates the session PIN vault and, on Tauri, re-enrols biometric so the keystore holds
 * the new PIN instead of the stale one. Shared by both the change and recovery flows.
 */
export async function applyNewPinLocally(
  newPin: string,
  log: (msg: string) => void
): Promise<void> {
  await savePin(newPin).catch(() => {});
  if (isTauriRuntime() && (await BiometricService.isConfigured().catch(() => false))) {
    await BiometricService.enableBiometric(newPin).catch((e) =>
      log(`[PIN] Ré-enrôlement biométrique échoué: ${e instanceof Error ? e.message : String(e)}`)
    );
  }
}

export interface PinChangeOptions {
  /** ID of the logged-in user whose PIN is changing. */
  userId: string;
  /** Live MLS service whose in-memory state will be re-encrypted under the new PIN. */
  mlsService: IMlsService;
  /** Updates the session's in-memory PIN so subsequent encryption uses the new value. */
  setPin: (pin: string) => void;
  /** Debug log sink. */
  log: (msg: string) => void;
}

/**
 * Performs the full PIN change. Throws with a user-facing message on failure
 * (e.g. wrong current PIN → "PIN actuel incorrect.").
 *
 * Server-first ordering: the verifier rotation is the operation gated on the old
 * PIN, so it runs first; the local re-encryption follows. If the local step were
 * to fail afterwards the user can still recover by re-logging in with the new PIN.
 */
export async function performPinChange(
  opts: PinChangeOptions,
  currentPin: string,
  newPin: string
): Promise<void> {
  const { userId, mlsService, setPin, log } = opts;
  log('[PIN_CHANGE] Démarrage du changement de PIN…');

  const [oldVerifier, newVerifier, token] = await Promise.all([
    computePinVerifier(userId, currentPin),
    computePinVerifier(userId, newPin),
    getToken(),
  ]);

  const res = await fetch('/api/mls/security/pin-change', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ userId, oldVerifier, newVerifier }),
  });
  if (res.status === 403) throw new Error('PIN actuel incorrect.');
  if (!res.ok) throw new Error('Échec du changement de PIN côté serveur.');

  // Verifier rotated - re-encrypt the local MLS state under the new PIN.
  await mlsService.changePIN(newPin);
  setPin(newPin);
  log('[PIN_CHANGE] État MLS re-chiffré avec le nouveau PIN.');

  // Refresh this device's stored PIN + biometric so silent re-login keeps working.
  await applyNewPinLocally(newPin, log);
  log('[PIN_CHANGE] Terminé.');
}
