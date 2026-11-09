import {
  AssociationPermissionFlag,
  SUPER_ADMIN_EXCLUDED_FLAGS,
  getMyBdeReach,
  hasPermissionFlag,
  listAssociations,
  listMyAssociations,
  type Association,
} from './api';
import { isGlobalAdmin } from '$lib/stores/user';
import { Log } from '$lib/utils/Log';

/**
 * The associations, lists and institutions the member may exercise `flag` on - what a "do it as"
 * picker offers (posts: `POST_AS_ASSO`; booking spaces: `MANAGE_BOOKINGS`). The client mirror of
 * the server's `mayAct`, in its three tiers: every one for a global admin; those where the member
 * holds `flag` in their own bitmask; and, for a flag a BDE super-admin inherits (not in
 * `SUPER_ADMIN_EXCLUDED_FLAGS`, so never a post's voice), the associations under their BDE's
 * `manageAsso` reach - which they may act on WITHOUT belonging to them. The server still checks.
 */
export async function listActableAssociations(
  flag: AssociationPermissionFlag
): Promise<Association[]> {
  if (isGlobalAdmin()) return listAssociations();
  const mine = await listMyAssociations();
  const own = mine.filter((a) => hasPermissionFlag(a.permissions ?? 0, flag));
  if ((flag & SUPER_ADMIN_EXCLUDED_FLAGS) !== 0) return own;
  const reach = (await getMyBdeReach()).manageAsso;
  const have = new Set(own.map((a) => a.id));
  const missing = reach.filter((id) => !have.has(id));
  if (missing.length === 0) return own;
  const directory = await listAssociations();
  const inherited = directory.filter((a) => missing.includes(a.id));
  Log.d('ASSOCIATIONS', `actable flag=${flag} own=${own.length} inherited=${inherited.length}`);
  return [...own, ...inherited];
}
