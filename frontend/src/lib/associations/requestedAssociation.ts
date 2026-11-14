import { AssociationPermissionFlag, type Association } from '$lib/associations/api';
import { Log } from '$lib/utils/Log';

/**
 * The memberships whose forms the reader MANAGES (MANAGE_FORMS): the only associations a form may be
 * created for or moved to (owner, 2026-11-14: only the members holding "gérer les formulaires"
 * manage an association's forms; social-service refuses anyone else `FORM_ASSOCIATION_NOT_YOURS`).
 * Offering a plain membership was offering a choice the save refuses.
 */
export function formManagedAssociations(mine: Association[]): Association[] {
  return mine.filter((a) => ((a.permissions ?? 0) & AssociationPermissionFlag.MANAGE_FORMS) !== 0);
}

/**
 * The association list a form builder offers, with the one the URL ASKED for guaranteed in it.
 *
 * `listMyAssociations` holds MEMBERSHIPS, so a global admin who is not a member arrived from an
 * association's own Formulaires tab to a builder with no selector and a preselected id that matched
 * nothing - and the paid toggle then claimed a form needs an association. The requested one is
 * therefore fetched by id when the memberships do not carry it. The server stays the authority: it
 * lets a global admin create for any association and refuses anyone else, so a fetched row here is
 * a choice, never a grant.
 *
 * A failed fetch is logged and leaves the list as it was - the id then matches nothing, which is
 * the same state as no id at all.
 */
export async function withRequestedAssociation(
  mine: Association[],
  requestedId: string,
  fetchOne: (id: string) => Promise<Association>
): Promise<Association[]> {
  if (!requestedId || mine.some((a) => a.id === requestedId)) return mine;
  try {
    const requested = await fetchOne(requestedId);
    Log.d('forms/create: requested association is not a membership, offering it', { requestedId });
    return [...mine, requested];
  } catch (err) {
    Log.d('forms/create: requested association could not be loaded', { requestedId, err });
    return mine;
  }
}
