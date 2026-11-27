import { startOidcLogin, type OidcLoginStart } from '$lib/stores/auth';
import { Log } from '$lib/utils/Log';

/**
 * "ACTIVER LE MAIL": AN ACCOUNT WITH NO SCHOOL ADDRESS ON THIS DEVICE RUNS THE MICONNECT SIGN-IN AGAIN
 * (decided product rule; docs/wiki/mail-client-transport.md#as-built---lot-3).
 *
 * The address reaches Canari only through MiConnect's `school_mail` claim, at a FULL sign-in (lot 1):
 * an account signed in before the claim existed has none until it signs in again. The Mail screen
 * therefore offers one button, and this is the one thing it calls. It runs the existing sign-in
 * entry point (`startOidcLogin`) and comes back to `/mail`; lot 1 is exposing a documented function
 * for exactly this, and when it lands this module calls it instead - the screen does not change.
 */
export async function activateSchoolMail(): Promise<OidcLoginStart> {
  Log.i('MAIL', 'activation: the MiConnect sign-in is run again for the school address');
  return startOidcLogin('/mail');
}
