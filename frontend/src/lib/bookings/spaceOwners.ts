import {
  AssociationPermissionFlag,
  hasPermissionFlag,
  listAssociations,
  listMyAssociations,
  type Association,
} from '$lib/associations/api';
import { isGlobalAdmin } from '$lib/stores/user';
import { Log } from '$lib/utils/Log';

/**
 * The associations, lists and institutions a member may create booking spaces for: every one for a
 * global admin, otherwise those where they hold `MANAGE_BOOKINGS` - the same shape as the posts'
 * `listPostAsAssociations` ("Publier en tant que"), with the flag the server asks of
 * `POST bookings/spaces`. The server still checks (`mayManageSpace`); this only decides what is
 * offered.
 */
export async function listSpaceOwnerChoices(): Promise<Association[]> {
  if (isGlobalAdmin()) return listAssociations();
  const mine = await listMyAssociations();
  const choices = mine.filter((a) =>
    hasPermissionFlag(a.permissions ?? 0, AssociationPermissionFlag.MANAGE_BOOKINGS)
  );
  Log.d('BOOKINGS', `space owner choices ${choices.length}/${mine.length}`);
  return choices;
}
