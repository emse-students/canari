import * as crypto from 'crypto';
import type { Message } from 'firebase-admin/messaging';
import { IOS_NOTIFICATION_SOUND } from '../services/push-payload';

/**
 * THE PURE HALF OF MAIL LOT 5'S SERVER PATH (docs/wiki/mail-client-transport.md#as-built---lot-5):
 * what a mail alert token is, how it is stored, how the Worker's secret is checked, and the EMPTY
 * push it triggers. No I/O, so each rule is asserted by `mail-alert.spec.ts` without a database.
 */

/** A token is 128 random bits as 32 lower-case hex characters - what the client draws. */
export const MAIL_ALERT_TOKEN_PATTERN = /^[0-9a-f]{32}$/;

/** The header Cloudflare's Email Worker carries its shared secret in. */
export const MAIL_ALERT_SECRET_HEADER = 'x-canari-mail-alert-secret';

/** The `type` of the empty push: the one key the devices branch on. Nothing else travels. */
export const MAIL_PUSH_TYPE = 'mail';

/** Whether `value` has the shape of a mail alert token. */
export function isMailAlertToken(value: unknown): value is string {
  return typeof value === 'string' && MAIL_ALERT_TOKEN_PATTERN.test(value);
}

/**
 * The stored form of a token: its SHA-256 in lower-case hex. A database copy then cannot be used to
 * trigger a push, and a hook post is matched by hashing what it carries.
 */
export function hashMailAlertToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Whether the secret a hook post carries is the estate's, compared in CONSTANT time over the SHA-256
 * of both (so unequal lengths leak nothing either). An estate with no secret configured refuses
 * everything: an empty expected value never matches.
 */
export function mailAlertSecretMatches(received: unknown, expected: string | undefined): boolean {
  const want = (expected ?? '').trim();
  if (!want || typeof received !== 'string' || !received) return false;
  const a = crypto.createHash('sha256').update(received, 'utf8').digest();
  const b = crypto.createHash('sha256').update(want, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

/** The generic sentence an iPhone shows when its extension cannot run, per language. */
const MAIL_ALERT_BODY: Record<string, string> = {
  fr: 'Nouveau mail',
  en: 'New mail',
};

/** The generic body for a device's language; the base locale (`fr`) when it told us nothing. */
export function mailAlertBody(locale?: string | null): string {
  const key = (locale ?? '').slice(0, 2).toLowerCase();
  return MAIL_ALERT_BODY[key] ?? MAIL_ALERT_BODY.fr;
}

/** What {@link buildMailPushMessage} needs of a push registration. */
export interface MailPushDestination {
  token: string;
  platform: 'android' | 'ios';
  locale: string | null;
}

/**
 * The EMPTY push of one new-mail alert, for one device: `{type: 'mail'}` and nothing else - no
 * sender, no subject, no mailbox, no id. The device fetches the mail itself, over its own TLS to the
 * school (charter principle 1).
 *
 * - Android: a data-only message at high priority, so `onMessageReceived` runs in a killed app.
 * - iOS: an ALERT with `mutable-content: 1`, so the Notification Service Extension wakes and rewrites
 *   it from what it reads; titled `Canari` with the localized generic body, which is what shows when
 *   the extension cannot run. No `thread-id` and no collapse id: two mails are two notifications.
 */
export function buildMailPushMessage(pt: MailPushDestination): Message {
  const data = { type: MAIL_PUSH_TYPE };
  if (pt.platform === 'ios') {
    return {
      token: pt.token,
      apns: {
        payload: {
          aps: {
            'mutable-content': 1,
            alert: { title: 'Canari', body: mailAlertBody(pt.locale) },
            sound: IOS_NOTIFICATION_SOUND.message,
          },
          ...data,
        },
        headers: { 'apns-push-type': 'alert', 'apns-priority': '10' },
      },
    };
  }
  return { token: pt.token, data, android: { priority: 'high', ttl: 24 * 3600 * 1000 } };
}
