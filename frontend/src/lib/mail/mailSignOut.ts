import { deliveryUrl } from '$lib/utils/apiUrl';
import { Log } from '$lib/utils/Log';
import { forgetMailPassword } from './sealedMailPassword';

/**
 * THE CANARI SIGN-OUT ENDS THE MAIL SESSION (docs/wiki/mail-client-transport.md#as-built---lot-3).
 *
 * `auth.ts`'s `clearAuth` runs for EVERY sign-out of the app (the dashboard, the navbar, the PIN
 * gate, an expired or revoked session) and calls {@link endMailOnSignOut}. The mail client registers
 * the one thing that must run then - `MailSession.signOut()`: the token dropped, the remembered
 * password forgotten, the server told - through {@link registerMailSignOut}, so `auth.ts` does not
 * import the mail client's graph (the SOAP client, the TLS loader) to sign out of a mailbox that was
 * never opened.
 *
 * A Canari ACCOUNT SWITCH needs nothing here: it goes through the same sign-out, and the mail client
 * is keyed on the Canari account id besides (`mailClient.svelte.ts`).
 *
 * THE LEAVING ACCOUNT'S REMEMBERED PASSWORD IS FORGOTTEN AT EVERY SIGN-OUT, client or none (review
 * I3): a password sealed in an earlier visit sits on the device whether or not this visit built a
 * mail client, and a sign-out that only reached a registered client would leave it behind.
 */

type MailSignOut = (reason: string) => Promise<void>;

/** A POST to the delivery service, authenticated with the token the leaving session still holds. */
export type AlertFetcher = (path: string, body: unknown) => Promise<Response>;

/**
 * The mail client's release of the account's alert rule (mail lot 5, `mailAlert.ts`): run while the
 * mailbox session is still open, with a fetcher that carries the leaving Canari token.
 */
type MailAlertRelease = (fetcher: AlertFetcher) => Promise<void>;

let registered: MailSignOut | null = null;
let registeredRelease: MailAlertRelease | null = null;
/** The release started for the sign-out under way: the mailbox's own sign-out waits for it. */
let releasing: Promise<void> | null = null;

/** Registers the mail client's sign-out (and its alert release); returns the unregister. One client at a time. */
export function registerMailSignOut(signOut: MailSignOut, release?: MailAlertRelease): () => void {
  registered = signOut;
  registeredRelease = release ?? null;
  return () => {
    if (registered === signOut) {
      registered = null;
      registeredRelease = null;
    }
  };
}

/**
 * STARTS the release of the account's alert rule at a Canari sign-out, BEFORE the sign-out forgets
 * the token: `auth.ts` calls it first, with the access token still in hand, and does not wait. The
 * mailbox's own sign-out ({@link endMailOnSignOut}) waits for it, so the rule is removed while the
 * mailbox session is still open. Never throws; a failure is logged, and the rule is then left to
 * another device's orphan repair (or outlives Canari - register C34).
 */
export function startMailAlertRelease(bearer: string): void {
  const release = registeredRelease;
  if (!release) return;
  const fetcher: AlertFetcher = (path, body) =>
    fetch(`${deliveryUrl()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
    });
  releasing = release(fetcher).catch((err: unknown) => {
    Log.w('MAIL-ALERT', `ERROR: the alert release at sign-out failed (${String(err)})`);
  });
}

/**
 * Ends the mail session, when one exists, because the Canari session ended, and forgets the
 * remembered password of `leavingUserId` in every case. Never throws: a sign-out of Canari must go
 * on whatever the mailbox answers, and a failure is logged as one.
 */
export async function endMailOnSignOut(
  reason: string,
  leavingUserId: string | null,
  store?: Storage
): Promise<void> {
  const signOut = registered;
  const release = releasing;
  releasing = null;
  if (release) await release;
  if (!signOut) {
    Log.d('MAIL', `canari sign-out (${reason}): no mail client to end`);
  } else {
    try {
      await signOut(reason);
    } catch (err) {
      Log.w(
        'MAIL',
        `ERROR: the mail session did not end with the canari sign-out (${reason})`,
        err
      );
    }
  }
  if (leavingUserId === null) {
    Log.d('MAIL', `canari sign-out (${reason}): no account id, no remembered password to forget`);
    return;
  }
  try {
    forgetMailPassword(leavingUserId, store ?? localStorage);
  } catch (err) {
    Log.w('MAIL', `ERROR: the remembered mail password was not forgotten (${reason})`, err);
  }
}
