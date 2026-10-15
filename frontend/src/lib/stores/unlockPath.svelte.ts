/**
 * The account whose unlock this launch is running WITHOUT the member - a device key read from this
 * account's own vault slot, or from the keystore with no prompt due - or `null`.
 *
 * WHY A PAGE NEEDS TO KNOW (F1 of community-open-budget, 2026-10-14). The Communities page draws the
 * saved community list, and the listing may start, before the session is up. That is only right
 * when nobody has to unlock anything: a device that asks for a PIN or a fingerprint is a locked
 * device, and a lock screen shows nothing of what it locks - neither while its prompt is on screen
 * nor after the prompt is left for another page (the PIN gate's "delete my account" link), nor in
 * the frames before the prompt is drawn.
 *
 * So the default is "locked" (`null`), and the ONE thing that sets an account here is the fact that
 * its key is in hand without a prompt: `nativeStorageLoginImpl` and the web branch of the shell
 * after a vault slot whose owner is proven, the keystore read when no prompt is due. A prompt (the
 * PIN gate) and every sign-out clear it. No clock: each write is a fact about the key.
 */

let unattendedFor = $state<string | null>(null);

/** The account being unlocked with no prompt, or `null` (unknown yet, or a prompt is owed). */
export function unlockUnattendedFor(): string | null {
  return unattendedFor;
}

/** This account's key is in hand without the member: its unlock prompts nobody. */
export function noteUnlockUnattended(userId: string): void {
  unattendedFor = userId;
}

/** A prompt is owed (the PIN gate), or the account left: nothing may be drawn before the unlock. */
export function noteUnlockNeedsMember(): void {
  unattendedFor = null;
}
