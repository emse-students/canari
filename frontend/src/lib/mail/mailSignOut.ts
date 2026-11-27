import { Log } from '$lib/utils/Log';

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
 */

type MailSignOut = (reason: string) => Promise<void>;

let registered: MailSignOut | null = null;

/** Registers the mail client's sign-out; returns the unregister. One client at a time. */
export function registerMailSignOut(signOut: MailSignOut): () => void {
  registered = signOut;
  return () => {
    if (registered === signOut) registered = null;
  };
}

/**
 * Ends the mail session, when one exists, because the Canari session ended. Never throws: a sign-out
 * of Canari must go on whatever the mailbox answers, and a failure is logged as one.
 */
export async function endMailOnSignOut(reason: string): Promise<void> {
  const signOut = registered;
  if (!signOut) {
    Log.d('MAIL', `canari sign-out (${reason}): no mail client to end`);
    return;
  }
  try {
    await signOut(reason);
  } catch (err) {
    Log.w('MAIL', `ERROR: the mail session did not end with the canari sign-out (${reason})`, err);
  }
}
