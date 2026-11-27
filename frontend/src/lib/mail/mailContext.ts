import { schoolMailAddress } from '$lib/stores/auth';
import type { MailContext } from './mailSession';

/**
 * THE ONE PLACE the mail session is wired to the signed-in Canari account
 * (docs/wiki/mail-client-transport.md#as-built---lot-2): its id, its device key, and its school
 * address - `schoolMailAddress()`, what MiConnect's `school_mail` claim named at the sign-in (lot 1),
 * never an address a user typed. Lot 3 builds the session with this; tests stub `MailContext`.
 */
export function canariMailContext(userId: string, deviceKey: () => string | null): MailContext {
  return { userId, deviceKey, mailAddress: schoolMailAddress };
}
