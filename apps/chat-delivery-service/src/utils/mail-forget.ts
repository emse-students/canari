import type { Logger } from '@nestjs/common';
import { getApps } from 'firebase-admin/app';
import { getMessaging, type Message } from 'firebase-admin/messaging';
import { createHash } from 'crypto';
import { describeFcmFailure } from './fcm-errors';
import { cutDeviceId, cutUserId } from './log-repeat';

/**
 * THE REMOTE FORGET OF THE SCHOOL MAILBOX (mail lot 5, D6;
 * docs/wiki/mail-client-transport.md#as-built---lot-5).
 *
 * A device that leaves the account through the SERVER - its owner revoked it, a session of it was
 * ended by "sign out everywhere else" / a logout / a replay / a restore elsewhere, or the account was
 * erased - is sent ONE data push `{type: 'mail-forget', userId}` on the registration being deleted, so
 * what it keeps of the mailbox outside the page goes at once: on Android the native watcher's sealed
 * copy of the password and the watcher itself (lot 4b's `NativeMailWatcher.forget`), on iOS the
 * Keychain item the notification extension reads and the shared cursor.
 *
 * It is the IMMEDIATE half, as `notifyDeviceRevoked` is for the socket: the durable half is the
 * device's own sign-out, which every refused refresh reaches and which erases the same things
 * (`forgetMailPassword`, `eraseMailPushSecret`). So the send is best effort and never blocks the
 * deletion it rides on: a failure is logged per device and the row still goes.
 *
 * Independent of `mail_push`: it rides on the push registrations every device has, so it holds with
 * `mail_push = none` too.
 *
 * EXACT BY CONSTRUCTION: the callers send it only for the rows THEIR delete removed (read, then
 * deleted one by one under the same filter), so a device that signed in again meanwhile - its row
 * rewritten with its new session - is never told to forget.
 *
 * AND EXACT ON ARRIVAL: a push can be delivered after the device signed in again (it was offline, or
 * the push was slow). So a forget for an ENDED SESSION carries the fingerprint of the registration
 * that session wrote ({@link registrationFingerprint}): every registration draws a new push secret,
 * which the device holds natively, so the device compares the fingerprint with its CURRENT secret and
 * forgets only when they match or when it is signed out (no secret). The device's running Canari
 * session is not known to the native push handlers; its registration secret is, and a registration is
 * bound to exactly one session. A device revoked as a whole (`scope: device`) and an erased account
 * (`scope: account`) forget unconditionally, as before.
 */

/** The `type` the devices branch on. */
export const MAIL_FORGET_TYPE = 'mail-forget';

/** Why the device is told to forget, for the log only (it never travels). */
export type MailForgetCause = 'device-revoked' | 'session-ended' | 'account-erased';

/** Which devices a forget is meant for - the field the device decides with (`scope`). */
export type MailForgetScope = 'session' | 'device' | 'account';

/** The scope each cause travels with. */
const SCOPE_OF: Record<MailForgetCause, MailForgetScope> = {
  'session-ended': 'session',
  'device-revoked': 'device',
  'account-erased': 'account',
};

/** What {@link buildMailForgetMessage} needs of a push registration. */
export interface MailForgetDestination {
  userId: string;
  deviceId: string;
  token: string;
  platform: 'android' | 'ios';
  /** The SHA-256 (hex) of the registration's push secret, as stored; `null` for a legacy row. */
  pushSecret: string | null;
}

/**
 * The fingerprint of a registration, from its STORED push secret (the hex SHA-256 of the raw secret
 * the device holds): the first 32 hex characters of `sha256("canari-mail-forget|" + stored)`. The
 * device computes the same from its raw secret (Kotlin `registrationFingerprintOf`, Rust
 * `registration_fingerprint`; one vector in `mailPushSecret.test.ts` holds the three together). It
 * names the registration without carrying the stored hash itself.
 */
export function registrationFingerprint(storedPushSecret: string): string {
  return createHash('sha256')
    .update(`canari-mail-forget|${storedPushSecret}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * How long Google and Apple keep a forget for a device that is offline: their maximum (28 days),
 * because a phone switched off when it was revoked must still forget when it comes back.
 */
const FORGET_TTL_SECONDS = 28 * 24 * 3600;

/**
 * The push: data only on Android (high priority, so it is delivered to a phone in Doze), a
 * BACKGROUND push on iOS (`content-available`, nothing drawn) that the app's silent-frame hook
 * handles (`canari_push.mm`). The account id rides along so a device holding ANOTHER account's
 * mailbox by then forgets nothing.
 */
export function buildMailForgetMessage(
  pt: MailForgetDestination,
  cause: MailForgetCause,
  nowMs: number
): Message {
  const scope = SCOPE_OF[cause];
  // `registration` is '' for a session-ended legacy row (no secret): the device then forgets only if
  // it is signed out.
  const data: Record<string, string> = { type: MAIL_FORGET_TYPE, userId: pt.userId, scope };
  if (scope === 'session') {
    data.registration = pt.pushSecret ? registrationFingerprint(pt.pushSecret) : '';
  }
  if (pt.platform === 'ios') {
    return {
      token: pt.token,
      apns: {
        payload: { aps: { 'content-available': 1 }, ...data },
        headers: {
          'apns-push-type': 'background',
          'apns-priority': '5',
          'apns-expiration': String(Math.floor(nowMs / 1000) + FORGET_TTL_SECONDS),
        },
      },
    };
  }
  return {
    token: pt.token,
    data,
    android: { priority: 'high', ttl: FORGET_TTL_SECONDS * 1000 },
  };
}

/** What {@link sendMailForget} did. */
export interface MailForgetTally {
  sent: number;
  failed: number;
}

/**
 * Sends the forget to each registration, a try PER DEVICE. Never throws: what fails is logged, and
 * the caller's deletion goes on.
 */
export async function sendMailForget(
  rows: readonly MailForgetDestination[],
  cause: MailForgetCause,
  logger: Pick<Logger, 'log' | 'warn' | 'error'>,
  send?: (message: Message) => Promise<string>
): Promise<MailForgetTally> {
  const tally: MailForgetTally = { sent: 0, failed: 0 };
  if (rows.length === 0) return tally;
  const sender = send ?? (getApps().length > 0 ? (m: Message) => getMessaging().send(m) : null);
  if (!sender) {
    logger.warn(`[MAIL_FORGET] Firebase not initialized - ${rows.length} forget(s) not sent`);
    tally.failed = rows.length;
    return tally;
  }
  const now = Date.now();
  for (const pt of rows) {
    const who = `user=${cutUserId(pt.userId)} device=${cutDeviceId(pt.deviceId)} platform=${pt.platform}`;
    try {
      await sender(buildMailForgetMessage(pt, cause, now));
      tally.sent++;
      logger.log(`[MAIL_FORGET] sent ${who} cause=${cause}`);
    } catch (e) {
      tally.failed++;
      const failure = describeFcmFailure(e);
      logger[failure.level](
        `[MAIL_FORGET] NOT sent ${who} cause=${cause} ${failure.text} - the device's own sign-out is what erases it now`
      );
    }
  }
  return tally;
}
