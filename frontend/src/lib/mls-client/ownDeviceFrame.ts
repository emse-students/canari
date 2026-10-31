import { canonicalUserId } from './leafIdentity';

/**
 * Whether a delivered frame was SENT BY THIS DEVICE, read from its envelope before MLS sees it.
 *
 * MLS never hands a member its own frame back (RFC 9420): at the current epoch it names it
 * (`CannotDecryptOwnMessage`), and at a PAST epoch it never gets that far - the epoch check refuses
 * it first as `TooDistantInThePast`, which the pipeline then reads as a message this device LOST.
 * Both answers are certain before the call, because the envelope already names its sender. So the
 * question is asked here, of the fact, rather than of the failure.
 *
 * THE DEVICE IS THE DISCRIMINATOR, NOT THE USER: this account's OTHER devices write frames that are
 * both decryptable and wanted. The user is checked too, so a frame is ours only when the envelope
 * names this account AND this device - the server admits a sender only as a member under that pair.
 *
 * ONLY THE CURRENT DEVICE ID COUNTS. An id this install abandoned at a rotation
 * (`abandonedDevices.ts`) names another MLS client, whose frames this state never held: they are a
 * foreign sender's frames and are handled as such.
 *
 * @param frame - the sender the envelope names; `deviceId` absent on a row written before the
 *   server carried it, which is never ours by this test.
 * @param self - this account and the device id this MLS client currently runs under.
 */
export function isFrameFromThisDevice(
  frame: { userId: string; deviceId: string | undefined },
  self: { userId: string; deviceId: string }
): boolean {
  if (!frame.deviceId || !self.deviceId) return false;
  return (
    frame.deviceId === self.deviceId &&
    canonicalUserId(frame.userId) === canonicalUserId(self.userId)
  );
}
