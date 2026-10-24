import type { AssociationPurchase } from './api';
import { getUserDisplayNameSync } from '$lib/utils/users/displayName';
import { m } from '$lib/paraglide/messages';

/**
 * The name an accounting row shows for its buyer: the name the server joined, else the cached
 * display name of the account, else - for a GUEST's payment on a public form, which names no
 * account (`userId` null, migration 103) - "Invite", as the responses table names one.
 *
 * One function for the association's own accounting and a parent's delegated view, which held a
 * copy each.
 */
export function purchaseBuyerName(
  purchase: Pick<AssociationPurchase, 'firstName' | 'lastName' | 'userId'>
): string {
  if (purchase.firstName || purchase.lastName) {
    return `${purchase.firstName ?? ''} ${purchase.lastName ?? ''}`.trim();
  }
  if (!purchase.userId) return m.form_submitter_guest();
  return getUserDisplayNameSync(purchase.userId);
}
